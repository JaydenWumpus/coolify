import { asyncExecShell, createDirectories, getEngine, getUserDetails } from '$lib/common';
import * as db from '$lib/database';
import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import type { RequestHandler } from '@sveltejs/kit';
import { ErrorHandler, getServiceImage } from '$lib/database';
import { makeLabelForServices } from '$lib/buildPacks/common';
import type { ComposeFile } from '$lib/types/composeFile';
import { getServiceMainPort } from '$lib/components/common';

export const post: RequestHandler = async (event) => {
	const { teamId, status, body } = await getUserDetails(event);
	if (status === 401) return { status, body };

	const { id } = event.params;

	try {
		const service = await db.getService({ id, teamId });
		const {
			type,
			version,
			fqdn,
			destinationDockerId,
			serviceSecret,
			destinationDocker,
			exposePort,
			wordpress: {
				mysqlDatabase,
				mysqlHost,
				mysqlPort,
				mysqlUser,
				mysqlPassword,
				extraConfig,
				mysqlRootUser,
				mysqlRootUserPassword,
				ownMysql
			}
		} = service;

		const network = destinationDockerId && destinationDocker.network;
		const host = getEngine(destinationDocker.engine);
		const image = getServiceImage(type);
		const port = getServiceMainPort('wordpress');

		const { workdir } = await createDirectories({ repository: type, buildId: id });
		const config = {
			wordpress: {
				image: `${image}:${version}`,
				volume: `${id}-wordpress-data:/var/www/html`,
				environmentVariables: {
					WORDPRESS_DB_HOST: ownMysql ? `${mysqlHost}:${mysqlPort}` : `${id}-mysql`,
					WORDPRESS_DB_USER: mysqlUser,
					WORDPRESS_DB_PASSWORD: mysqlPassword,
					WORDPRESS_DB_NAME: mysqlDatabase,
					WORDPRESS_CONFIG_EXTRA: extraConfig
				}
			},
			mysql: {
				image: `bitnami/mysql:5.7`,
				volume: `${id}-mysql-data:/bitnami/mysql/data`,
				environmentVariables: {
					MYSQL_ROOT_PASSWORD: mysqlRootUserPassword,
					MYSQL_ROOT_USER: mysqlRootUser,
					MYSQL_USER: mysqlUser,
					MYSQL_PASSWORD: mysqlPassword,
					MYSQL_DATABASE: mysqlDatabase
				}
			}
		};
		if (serviceSecret.length > 0) {
			serviceSecret.forEach((secret) => {
				config.wordpress.environmentVariables[secret.name] = secret.value;
			});
		}
		let composeFile: ComposeFile = {
			version: '3.8',
			services: {
				[id]: {
					container_name: id,
					image: config.wordpress.image,
					environment: config.wordpress.environmentVariables,
					volumes: [config.wordpress.volume],
					networks: [network],
					restart: 'always',
					...(exposePort ? { ports: [`${exposePort}:${port}`] } : {}),
					labels: makeLabelForServices('wordpress'),
					deploy: {
						restart_policy: {
							condition: 'on-failure',
							delay: '5s',
							max_attempts: 3,
							window: '120s'
						}
					}
				}
			},
			networks: {
				[network]: {
					external: true
				}
			},
			volumes: {
				[config.wordpress.volume.split(':')[0]]: {
					name: config.wordpress.volume.split(':')[0]
				}
			}
		};
		if (!ownMysql) {
			composeFile.services[id].depends_on = [`${id}-mysql`];
			composeFile.services[`${id}-mysql`] = {
				container_name: `${id}-mysql`,
				image: config.mysql.image,
				volumes: [config.mysql.volume],
				environment: config.mysql.environmentVariables,
				networks: [network],
				restart: 'always',
				deploy: {
					restart_policy: {
						condition: 'on-failure',
						delay: '5s',
						max_attempts: 3,
						window: '120s'
					}
				}
			};

			composeFile.volumes[config.mysql.volume.split(':')[0]] = {
				name: config.mysql.volume.split(':')[0]
			};
		}
		const composeFileDestination = `${workdir}/docker-compose.yaml`;
		await fs.writeFile(composeFileDestination, yaml.dump(composeFile));
		try {
			await asyncExecShell(`DOCKER_HOST=${host} docker compose -f ${composeFileDestination} pull`);
			await asyncExecShell(`DOCKER_HOST=${host} docker compose -f ${composeFileDestination} up -d`);
			return {
				status: 200
			};
		} catch (error) {
			console.log(error);
			return ErrorHandler(error);
		}
	} catch (error) {
		return ErrorHandler(error);
	}
};

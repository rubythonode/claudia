const aws = require('aws-sdk'),
	validAuthType = require('../util/valid-auth-type'),
	sequentialPromiseMap = require('../util/sequential-promise-map'),
	validCredentials = require('../util/valid-credentials'),
	allowApiInvocation = require('./allow-api-invocation'),
	pathSplitter = require('../util/path-splitter'),
	loggingWrap = require('../util/logging-wrap'),
	retriableWrap = require('../util/retriable-wrap'),
	NullLogger = require('../util/null-logger'),
	safeHash = require('../util/safe-hash'),
	flattenRequestParameters = require('./flatten-request-parameters'),
	patchBinaryTypes = require('./patch-binary-types'),
	getOwnerId = require('./get-owner-account-id'),
	registerAuthorizers = require('./register-authorizers');
module.exports = function rebuildWebApi(functionName, functionVersion, restApiId, apiConfig, awsRegion, optionalLogger, configCacheStageVar) {
	'use strict';
	let existingResources,
		ownerId,
		authorizerIds;
	const logger = optionalLogger || new NullLogger(),
		apiGateway = retriableWrap(
						loggingWrap(
							new aws.APIGateway({region: awsRegion}),
							{log: logger.logApiCall, logName: 'apigateway'}
						),
						() => logger.logApiCall('rate-limited by AWS, waiting before retry')),
		configHash = safeHash(apiConfig),
		knownIds = {},
		findByPath = function (resourceItems, path) {
			let result;
			resourceItems.forEach(item => {
				if (item.path === path) {
					result = item;
				}
			});
			return result;
		},
		getExistingResources = function () {
			return apiGateway.getResourcesPromise({restApiId: restApiId, limit: 499});
		},
		findRoot = function () {
			const rootResource = findByPath(existingResources, '/');
			knownIds[''] = rootResource.id;
			return rootResource.id;
		},
		supportsCors = function () {
			return (apiConfig.corsHandlers !== false);
		},
		putMockIntegration = function (resourceId, httpMethod) {
			return apiGateway.putIntegrationPromise({
				restApiId: restApiId,
				resourceId: resourceId,
				httpMethod: httpMethod,
				type: 'MOCK',
				requestTemplates: {
					'application/json': '{\"statusCode\": 200}'
				}
			});
		},
		putLambdaIntegration = function (resourceId, methodName, credentials, cacheKeyParameters, integrationContentHandling) {
			return apiGateway.putIntegrationPromise({
				restApiId: restApiId,
				resourceId: resourceId,
				httpMethod: methodName,
				credentials: credentials,
				type: 'AWS_PROXY',
				cacheKeyParameters: cacheKeyParameters,
				integrationHttpMethod: 'POST',
				passthroughBehavior: 'WHEN_NO_MATCH',
				contentHandling: integrationContentHandling,
				uri: 'arn:aws:apigateway:' + awsRegion + ':lambda:path/2015-03-31/functions/arn:aws:lambda:' + awsRegion + ':' + ownerId + ':function:' + functionName + ':${stageVariables.lambdaVersion}/invocations'
			});
		},
		corsHeaderValue = function () {
			const val = apiConfig.corsHeaders || 'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token';
			if (!supportsCors()) {
				return '';
			}
			return '\'' + val + '\'';
		},
		createMethod = function (methodName, resourceId, path) {
			const methodOptions = apiConfig.routes[path][methodName],
				apiKeyRequired = function () {
					return methodOptions && methodOptions.apiKeyRequired;
				},
				authorizationType = function () {
					if (methodOptions && methodOptions.authorizationType && validAuthType(methodOptions.authorizationType.toUpperCase())) {
						return methodOptions.authorizationType.toUpperCase();
					} else if (methodOptions.customAuthorizer) {
						return 'CUSTOM';
					} else if (methodOptions && validCredentials(methodOptions.invokeWithCredentials)) {
						return 'AWS_IAM';
					} else {
						return 'NONE';
					}
				},
				credentials = function () {
					if (methodOptions && methodOptions.invokeWithCredentials) {
						if (methodOptions.invokeWithCredentials === true) {
							return 'arn:aws:iam::*:user/*';
						} else if (validCredentials(methodOptions.invokeWithCredentials)) {
							return methodOptions.invokeWithCredentials;
						}
					}
					return null;
				},
				addMethodResponse = function () {
					return apiGateway.putMethodResponsePromise({
						restApiId: restApiId,
						resourceId: resourceId,
						httpMethod: methodName,
						statusCode: '200'
					})
					.then(() => apiGateway.putIntegrationResponsePromise({
						restApiId: restApiId,
						resourceId: resourceId,
						httpMethod: methodName,
						contentHandling: methodOptions && methodOptions.success && methodOptions.success.contentHandling,
						statusCode: '200'
					}));
				},
				authorizerId = function () {
					return methodOptions && methodOptions.customAuthorizer && authorizerIds[methodOptions.customAuthorizer];
				},
				parameters = flattenRequestParameters(methodOptions.requestParameters, path);
			return apiGateway.putMethodPromise({
				authorizationType: authorizationType(),
				authorizerId: authorizerId(),
				httpMethod: methodName,
				resourceId: resourceId,
				restApiId: restApiId,
				requestParameters: parameters,
				apiKeyRequired: apiKeyRequired()
			})
			.then(() => putLambdaIntegration(resourceId, methodName, credentials(), parameters && Object.keys(parameters), methodOptions.requestContentHandling))
			.then(addMethodResponse);
		},
		createCorsHandler = function (resourceId) {
			return apiGateway.putMethodPromise({
				authorizationType: 'NONE',
				httpMethod: 'OPTIONS',
				resourceId: resourceId,
				restApiId: restApiId
			})
			.then(() => {
				if (apiConfig.corsHandlers) {
					return putLambdaIntegration(resourceId, 'OPTIONS');
				} else {
					return putMockIntegration(resourceId, 'OPTIONS');
				}
			})
			.then(() => {
				let responseParams = null;
				if (!apiConfig.corsHandlers) {
					responseParams = {
						'method.response.header.Access-Control-Allow-Headers': false,
						'method.response.header.Access-Control-Allow-Methods': false,
						'method.response.header.Access-Control-Allow-Origin': false,
						'method.response.header.Access-Control-Allow-Credentials': false,
						'method.response.header.Access-Control-Max-Age': false
					};
				}
				return apiGateway.putMethodResponsePromise({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					statusCode: '200',
					responseParameters: responseParams
				});
			})
			.then(() => {
				let responseParams = null;

				if (!apiConfig.corsHandlers) {
					responseParams = {
						'method.response.header.Access-Control-Allow-Headers': corsHeaderValue(),
						'method.response.header.Access-Control-Allow-Methods': '\'DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT\'',
						'method.response.header.Access-Control-Allow-Origin': '\'*\'',
						'method.response.header.Access-Control-Allow-Credentials': '\'true\''
					};
					if (apiConfig.corsMaxAge) {
						responseParams['method.response.header.Access-Control-Max-Age'] = '\'' + apiConfig.corsMaxAge + '\'';
					}
				}
				return apiGateway.putIntegrationResponsePromise({
					restApiId: restApiId,
					resourceId: resourceId,
					httpMethod: 'OPTIONS',
					statusCode: '200',
					responseParameters: responseParams
				});
			});
		},
		findResourceByPath = function (path) {
			const pathComponents = pathSplitter(path);
			if (knownIds[path]) {
				return Promise.resolve(knownIds[path]);
			} else {
				return findResourceByPath(pathComponents.parentPath)
				.then(parentId => apiGateway.createResourcePromise({
					restApiId: restApiId,
					parentId: parentId,
					pathPart: pathComponents.pathPart
				}))
				.then(resource => {
					knownIds[path] = resource.id;
					return resource.id;
				});
			}
		},
		configurePath = function (path) {
			let resourceId;
			const supportedMethods = Object.keys(apiConfig.routes[path]),
				createMethodMapper = function (methodName) {
					return createMethod(methodName, resourceId, path);
				};
			return findResourceByPath(path)
			.then(r => {
				resourceId = r;
			})
			.then(() => sequentialPromiseMap(supportedMethods, createMethodMapper))
			.then(() => {
				if (supportsCors()) {
					return createCorsHandler(resourceId);
				}
			});
		},
		dropMethods = function (resource) {
			const dropMethodMapper = function (method) {
				return apiGateway.deleteMethodPromise({
					resourceId: resource.id,
					restApiId: restApiId,
					httpMethod: method
				});
			};
			if (resource.resourceMethods) {
				return sequentialPromiseMap(Object.keys(resource.resourceMethods), dropMethodMapper);
			} else {
				return Promise.resolve();
			}
		},
		removeResource = function (resource) {
			if (resource.path !== '/') {
				return apiGateway.deleteResourcePromise({
					resourceId: resource.id,
					restApiId: restApiId
				});
			} else {
				return dropMethods(resource);
			}
		},
		dropSubresources = function () {
			let currentResource;
			if (existingResources.length === 0) {
				return Promise.resolve();
			} else {
				currentResource = existingResources.pop();
				return removeResource(currentResource)
				.then(() => {
					if (existingResources.length > 0) {
						return dropSubresources();
					}
				});
			}
		},
		pathSort = function (resA, resB) {
			if (resA.path > resB.path) {
				return 1;
			} else if (resA.path === resB.path) {
				return 0;
			}
			return -1;
		},
		removeExistingResources = function () {
			return getExistingResources()
			.then(resources => {
				existingResources = resources.items;
				existingResources.sort(pathSort);
				return existingResources;
			})
			.then(findRoot)
			.then(dropSubresources);
		},
		rebuildApi = function () {
			return allowApiInvocation(functionName, functionVersion, restApiId, ownerId, awsRegion)
			.then(() => sequentialPromiseMap(Object.keys(apiConfig.routes), configurePath));
		},
		deployApi = function () {
			const stageVars = {
				lambdaVersion: functionVersion
			};
			if (configCacheStageVar) {
				stageVars[configCacheStageVar] = configHash;
			}

			return apiGateway.createDeploymentPromise({
				restApiId: restApiId,
				stageName: functionVersion,
				variables: stageVars
			});
		},
		configureAuthorizers = function () {
			if (apiConfig.authorizers && apiConfig.authorizers !== {}) {
				return registerAuthorizers(apiConfig.authorizers, restApiId, awsRegion, functionVersion, logger)
				.then(result => {
					authorizerIds = result;
				});
			} else {
				authorizerIds = {};
			}
		},
		uploadApiConfig = function () {
			return removeExistingResources()
				.then(configureAuthorizers)
				.then(rebuildApi)
				.then(deployApi)
				.then(() => ({ cacheReused: false }));
		},
		getExistingConfigHash = function () {
			if (!configCacheStageVar) {
				return false;
			}
			return apiGateway.getStagePromise({ restApiId: restApiId, stageName: functionVersion })
				.then(stage => stage.variables && stage.variables[configCacheStageVar])
				.catch(() => false);
		};
	return getOwnerId(logger)
		.then(accountOwnerId => {
			ownerId = accountOwnerId;
		})
		.then(() => patchBinaryTypes(restApiId, apiGateway, apiConfig.binaryMediaTypes))
		.then(getExistingConfigHash)
		.then(existingHash => {
			if (existingHash && existingHash === configHash) {
				logger.logStage('Reusing cached API configuration');
				return { cacheReused: true };
			} else {
				return uploadApiConfig();
			}
		});
};

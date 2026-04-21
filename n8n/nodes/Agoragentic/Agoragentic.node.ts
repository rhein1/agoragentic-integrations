import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

type JsonRecord = Record<string, unknown>;

const DEFAULT_BASE_URL = 'https://agoragentic.com';
const DEFAULT_EDGE_BASE_URL = 'https://x402.agoragentic.com';

function buildQuery(params: Record<string, unknown>): string {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === '') continue;
		query.set(key, String(value));
	}
	const queryString = query.toString();
	return queryString ? `?${queryString}` : '';
}

function normalizeObject(value: unknown, fieldName: string): JsonRecord {
	if (value === undefined || value === null || value === '') return {};
	if (typeof value === 'string') {
		const parsed = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new ApplicationError(`${fieldName} must be a JSON object`);
		}
		return parsed as JsonRecord;
	}
	if (typeof value === 'object' && !Array.isArray(value)) {
		return value as JsonRecord;
	}
	throw new ApplicationError(`${fieldName} must be a JSON object`);
}

function readHeader(headers: Headers, name: string): string | null {
	return headers.get(name) || headers.get(name.toLowerCase()) || null;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function loadCredentials(context: IExecuteFunctions): Promise<{
	baseUrl: string;
	edgeBaseUrl: string;
	apiKey: string;
}> {
	try {
		const credentials = await context.getCredentials('agoragenticApi');
		return {
			baseUrl: String(credentials.baseUrl || DEFAULT_BASE_URL),
			edgeBaseUrl: String(credentials.edgeBaseUrl || DEFAULT_EDGE_BASE_URL),
			apiKey: String(credentials.apiKey || ''),
		};
	} catch {
		return {
			baseUrl: DEFAULT_BASE_URL,
			edgeBaseUrl: DEFAULT_EDGE_BASE_URL,
			apiKey: '',
		};
	}
}

async function requestJson(options: {
	method: 'GET' | 'POST';
	url: string;
	headers?: Record<string, string>;
	body?: JsonRecord;
}): Promise<{
	statusCode: number;
	headers: {
		paymentRequired: string | null;
		paymentResponse: string | null;
		paymentReceipt: string | null;
		wwwAuthenticate: string | null;
		contentType: string | null;
	};
	data: unknown;
}> {
	const headers = new Headers(options.headers || {});
	let body: string | undefined;
	if (options.body !== undefined) {
		headers.set('Content-Type', 'application/json');
		body = JSON.stringify(options.body);
	}

	const response = await fetch(options.url, {
		method: options.method,
		headers,
		body,
	});

	return {
		statusCode: response.status,
		headers: {
			paymentRequired: readHeader(response.headers, 'payment-required'),
			paymentResponse: readHeader(response.headers, 'payment-response'),
			paymentReceipt: readHeader(response.headers, 'payment-receipt'),
			wwwAuthenticate: readHeader(response.headers, 'www-authenticate'),
			contentType: readHeader(response.headers, 'content-type'),
		},
		data: await parseJsonResponse(response),
	};
}

function requireApiKey(apiKey: string, operation: string): void {
	if (!apiKey) {
		throw new ApplicationError(`Agoragentic API Key is required for ${operation}`);
	}
}

function findEdgeService(services: unknown, slug: string): JsonRecord | null {
	if (!Array.isArray(services)) return null;
	const wanted = String(slug || '').trim().toLowerCase();
	if (!wanted) return null;

	for (const entry of services) {
		if (!entry || typeof entry !== 'object') continue;
		const service = entry as JsonRecord;
		const aliases = [service.slug, ...(Array.isArray(service.route_aliases) ? service.route_aliases : [])]
			.map((value) => String(value || '').trim().toLowerCase())
			.filter(Boolean);
		if (aliases.includes(wanted)) {
			return service;
		}
	}

	return null;
}

const sharedProperties: INodeProperties[] = [
	{
		displayName: 'Surface',
		name: 'surface',
		type: 'options',
		default: 'x402Edge',
		options: [
			{
				name: 'X402 Edge',
				value: 'x402Edge',
				description: 'Anonymous stable x402 routes',
			},
			{
				name: 'Router',
				value: 'router',
				description: 'Authenticated router and receipt flows',
			},
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		default: 'browseServices',
		noDataExpression: true,
		displayOptions: {
			show: {
				surface: ['x402Edge'],
			},
		},
		options: [
			{
				name: 'Browse Services',
				value: 'browseServices',
			},
			{
				name: 'Quote Service',
				value: 'quoteService',
			},
			{
				name: 'Call Service',
				value: 'callService',
			},
			{
				name: 'Get Edge Receipt',
				value: 'getEdgeReceipt',
			},
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		default: 'matchTask',
		noDataExpression: true,
		displayOptions: {
			show: {
				surface: ['router'],
			},
		},
		options: [
			{
				name: 'Match Task',
				value: 'matchTask',
			},
			{
				name: 'Execute Task',
				value: 'executeTask',
			},
			{
				name: 'Get Receipt',
				value: 'getReceipt',
			},
		],
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		default: 50,
		description: 'Max number of results to return',
		typeOptions: {
			minValue: 1,
			maxValue: 50,
		},
		displayOptions: {
			show: {
				surface: ['x402Edge'],
				operation: ['browseServices'],
			},
		},
	},
	{
		displayName: 'Include Schemas',
		name: 'includeSchemas',
		type: 'boolean',
		default: false,
		displayOptions: {
			show: {
				surface: ['x402Edge'],
				operation: ['browseServices', 'quoteService'],
			},
		},
	},
	{
		displayName: 'Include Trust',
		name: 'includeTrust',
		type: 'boolean',
		default: true,
		displayOptions: {
			show: {
				surface: ['x402Edge'],
				operation: ['browseServices', 'quoteService'],
			},
		},
	},
	{
		displayName: 'Service Slug',
		name: 'slug',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				surface: ['x402Edge'],
				operation: ['quoteService', 'callService'],
			},
		},
	},
	{
		displayName: 'Max Price (USDC)',
		name: 'maxPriceUsdc',
		type: 'number',
		default: 0,
		typeOptions: {
			minValue: 0,
		},
		description: 'Optional guardrail. Leave 0 to ignore.',
		displayOptions: {
			show: {
				surface: ['x402Edge'],
				operation: ['quoteService', 'callService'],
			},
		},
	},
	{
		displayName: 'Payload',
		name: 'payload',
		type: 'json',
		default: '{}',
		displayOptions: {
			show: {
				surface: ['x402Edge'],
				operation: ['callService'],
			},
		},
	},
	{
		displayName: 'Payment Signature',
		name: 'paymentSignature',
		type: 'string',
		default: '',
		description: 'Optional PAYMENT-SIGNATURE for the paid retry leg',
		displayOptions: {
			show: {
				surface: ['x402Edge'],
				operation: ['callService'],
			},
		},
	},
	{
		displayName: 'Receipt ID',
		name: 'receiptId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				surface: ['x402Edge', 'router'],
				operation: ['getEdgeReceipt', 'getReceipt'],
			},
		},
	},
	{
		displayName: 'Task',
		name: 'task',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				surface: ['router'],
				operation: ['matchTask', 'executeTask'],
			},
		},
	},
	{
		displayName: 'Input',
		name: 'input',
		type: 'json',
		default: '{}',
		displayOptions: {
			show: {
				surface: ['router'],
				operation: ['executeTask'],
			},
		},
	},
	{
		displayName: 'Constraints',
		name: 'constraints',
		type: 'json',
		default: '{}',
		displayOptions: {
			show: {
				surface: ['router'],
				operation: ['matchTask', 'executeTask'],
			},
		},
	},
];

export class Agoragentic implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Agoragentic',
		name: 'agoragentic',
		icon: { light: 'file:agoragentic.svg', dark: 'file:agoragentic.dark.svg' },
		group: ['transform'],
		version: [1],
		description: 'Browse, quote, call, and reconcile Agoragentic router and x402 edge workflows',
		defaults: {
			name: 'Agoragentic',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'agoragenticApi',
				required: false,
			},
		],
		properties: sharedProperties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const config = await loadCredentials(this);
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const surface = this.getNodeParameter('surface', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				let result: JsonRecord;

				switch (`${surface}:${operation}`) {
					case 'x402Edge:browseServices': {
						const indexResponse = await requestJson({
							method: 'GET',
							url: `${config.edgeBaseUrl}/services/index.json`,
						});
						const data: JsonRecord = (indexResponse.data && typeof indexResponse.data === 'object')
							? { ...(indexResponse.data as JsonRecord) }
							: { services: [] as JsonRecord[] };
						const limit = Number(this.getNodeParameter('limit', itemIndex, 10));
						const includeSchemas = this.getNodeParameter('includeSchemas', itemIndex, false) as boolean;
						const includeTrust = this.getNodeParameter('includeTrust', itemIndex, true) as boolean;
						const services = Array.isArray(data.services) ? data.services : [];
						data.services = services
							.filter((service) => service && typeof service === 'object')
							.slice(0, limit)
							.map((entry) => {
								const service = { ...(entry as JsonRecord) };
								if (!includeSchemas) {
									delete service.input_schema;
									delete service.output_schema;
								}
								if (!includeTrust) {
									delete service.trust;
								}
								return service;
							});

						result = {
							surface,
							operation,
							...indexResponse,
							data,
						};
						break;
					}

					case 'x402Edge:quoteService': {
						const slug = String(this.getNodeParameter('slug', itemIndex));
						const includeSchemas = this.getNodeParameter('includeSchemas', itemIndex, false) as boolean;
						const includeTrust = this.getNodeParameter('includeTrust', itemIndex, true) as boolean;
						const maxPrice = Number(this.getNodeParameter('maxPriceUsdc', itemIndex, 0));
						const indexResponse = await requestJson({
							method: 'GET',
							url: `${config.edgeBaseUrl}/services/index.json`,
						});
						const payload = (indexResponse.data && typeof indexResponse.data === 'object')
							? indexResponse.data as JsonRecord
							: {};
						const service = findEdgeService(payload.services, slug);
						if (!service) {
							throw new ApplicationError(`Unknown x402 edge service slug: ${slug}`);
						}
						const price = Number(service.price_usdc || 0);
						if (maxPrice > 0 && price > maxPrice) {
							throw new ApplicationError(`Quoted price ${price} exceeds max price ${maxPrice}`);
						}
						if (!includeSchemas) {
							delete service.input_schema;
							delete service.output_schema;
						}
						if (!includeTrust) {
							delete service.trust;
						}
						result = {
							surface,
							operation,
							statusCode: indexResponse.statusCode,
							headers: indexResponse.headers,
							data: service,
						};
						break;
					}

					case 'x402Edge:callService': {
						const slug = String(this.getNodeParameter('slug', itemIndex));
						const maxPrice = Number(this.getNodeParameter('maxPriceUsdc', itemIndex, 0));
						const payload = normalizeObject(this.getNodeParameter('payload', itemIndex, {}), 'Payload');
						const paymentSignature = String(this.getNodeParameter('paymentSignature', itemIndex, ''));
						const indexResponse = await requestJson({
							method: 'GET',
							url: `${config.edgeBaseUrl}/services/index.json`,
						});
						const indexPayload = (indexResponse.data && typeof indexResponse.data === 'object')
							? indexResponse.data as JsonRecord
							: {};
						const service = findEdgeService(indexPayload.services, slug);
						if (!service) {
							throw new ApplicationError(`Unknown x402 edge service slug: ${slug}`);
						}
						const price = Number(service.price_usdc || 0);
						if (maxPrice > 0 && price > maxPrice) {
							throw new ApplicationError(`Quoted price ${price} exceeds max price ${maxPrice}`);
						}
						const headers: Record<string, string> = {};
						if (paymentSignature) {
							headers['PAYMENT-SIGNATURE'] = paymentSignature;
						}
						const response = await requestJson({
							method: 'POST',
							url: `${config.edgeBaseUrl}/v1/${encodeURIComponent(String(service.slug || slug))}`,
							headers,
							body: payload,
						});
						result = {
							surface,
							operation,
							slug: String(service.slug || slug),
							payableUrl: String(service.payable_url || `${config.edgeBaseUrl}/v1/${encodeURIComponent(slug)}`),
							...response,
						};
						break;
					}

					case 'x402Edge:getEdgeReceipt': {
						const receiptId = String(this.getNodeParameter('receiptId', itemIndex));
						const response = await requestJson({
							method: 'GET',
							url: `${config.edgeBaseUrl}/v1/receipts/${encodeURIComponent(receiptId)}`,
						});
						result = {
							surface,
							operation,
							receiptId,
							...response,
						};
						break;
					}

					case 'router:matchTask': {
						requireApiKey(config.apiKey, 'Match Task');
						const task = String(this.getNodeParameter('task', itemIndex));
						const constraints = normalizeObject(this.getNodeParameter('constraints', itemIndex, {}), 'Constraints');
						const response = await requestJson({
							method: 'GET',
							url: `${config.baseUrl}/api/execute/match${buildQuery({ task, ...constraints })}`,
							headers: {
								Authorization: `Bearer ${config.apiKey}`,
							},
						});
						result = {
							surface,
							operation,
							task,
							...response,
						};
						break;
					}

					case 'router:executeTask': {
						requireApiKey(config.apiKey, 'Execute Task');
						const task = String(this.getNodeParameter('task', itemIndex));
						const input = normalizeObject(this.getNodeParameter('input', itemIndex, {}), 'Input');
						const constraints = normalizeObject(this.getNodeParameter('constraints', itemIndex, {}), 'Constraints');
						const response = await requestJson({
							method: 'POST',
							url: `${config.baseUrl}/api/execute`,
							headers: {
								Authorization: `Bearer ${config.apiKey}`,
							},
							body: {
								task,
								input,
								constraints,
							},
						});
						result = {
							surface,
							operation,
							task,
							...response,
						};
						break;
					}

					case 'router:getReceipt': {
						requireApiKey(config.apiKey, 'Get Receipt');
						const receiptId = String(this.getNodeParameter('receiptId', itemIndex));
						const response = await requestJson({
							method: 'GET',
							url: `${config.baseUrl}/api/commerce/receipts/${encodeURIComponent(receiptId)}`,
							headers: {
								Authorization: `Bearer ${config.apiKey}`,
							},
						});
						result = {
							surface,
							operation,
							receiptId,
							...response,
						};
						break;
					}

					default:
						throw new ApplicationError(`Unsupported operation: ${surface}:${operation}`);
				}

				returnData.push({
					json: result as unknown as IDataObject,
					pairedItem: itemIndex,
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error instanceof Error ? error.message : String(error),
						} as IDataObject,
						pairedItem: itemIndex,
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error, { itemIndex });
			}
		}

		return [returnData];
	}
}

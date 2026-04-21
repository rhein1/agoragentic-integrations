import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class AgoragenticApi implements ICredentialType {
	name = 'agoragenticApi';

	displayName = 'Agoragentic API';

	icon: Icon = 'file:agoragentic.svg';

	documentationUrl = 'https://github.com/rhein1/agoragentic-integrations/tree/main/n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://agoragentic.com',
		},
		{
			displayName: 'x402 Edge URL',
			name: 'edgeBaseUrl',
			type: 'string',
			default: 'https://x402.agoragentic.com',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: false,
			default: '',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl || "https://agoragentic.com"}}',
			url: '/api/categories',
		},
	};
}

import js from '@eslint/js';
import { n8nCommunityNodesPlugin } from '@n8n/eslint-plugin-community-nodes';
import { globalIgnores } from 'eslint/config';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import importX from 'eslint-plugin-import-x';
import n8nNodesBase from 'eslint-plugin-n8n-nodes-base';
import tseslint from 'typescript-eslint';

const communityNodesRecommended = n8nCommunityNodesPlugin.configs.recommended;

export default tseslint.config(
	globalIgnores(['dist']),
	{
		files: ['**/*.ts'],
		extends: [
			js.configs.recommended,
			tseslint.configs.recommended,
			communityNodesRecommended,
			importX.configs['flat/recommended'],
		],
		rules: {
			'prefer-spread': 'off',
			'no-console': 'error',
		},
	},
	{
		plugins: { 'n8n-nodes-base': n8nNodesBase },
		settings: {
			'import-x/resolver-next': [createTypeScriptImportResolver()],
		},
	},
	{
		files: ['package.json'],
		extends: [communityNodesRecommended],
		rules: {
			...n8nNodesBase.configs.community.rules,
		},
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				extraFileExtensions: ['.json'],
			},
		},
	},
	{
		files: ['./credentials/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.credentials.rules,
			'n8n-nodes-base/cred-class-field-documentation-url-miscased': 'off',
			'n8n-nodes-base/cred-class-field-type-options-password-missing': 'off',
		},
	},
	{
		files: ['./nodes/**/*.ts'],
		rules: {
			...n8nNodesBase.configs.nodes.rules,
			'n8n-nodes-base/node-class-description-inputs-wrong-regular-node': 'off',
			'n8n-nodes-base/node-class-description-outputs-wrong': 'off',
			'n8n-nodes-base/node-param-type-options-max-value-present': 'off',
		},
	},
);

import css from '@eslint/css'
import json from '@eslint/json'
import markdown from '@eslint/markdown'
import obsidianmd from 'eslint-plugin-obsidianmd'
import solid from 'eslint-plugin-solid/configs/typescript'
import unusedImports from 'eslint-plugin-unused-imports'
import type { Config } from 'eslint/config'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const codeFiles = ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}']
const typedFiles = ['**/*.{ts,mts,cts,tsx}']
const testFiles = ['**/*.test.{ts,mts,cts,tsx}', 'test/**/*.{ts,mts,cts,tsx}']
const tsconfigFiles = ['**/tsconfig*.json']

const nodeFiles = [
	'scripts/**/*.{js,mjs,cjs,ts,mts,cts}',
	'*.config.{js,mjs,cjs,ts,mts,cts}',
	'version-bump.mjs',
]

const configDir = dirname(fileURLToPath(import.meta.url))

// eslint-plugin-obsidianmd intentionally exposes browser globals globally.
// Tooling files run under Node instead, so explicitly remove browser globals
// before enabling the Node environment for those files.
const disabledBrowserGlobals: Record<string, 'off'> = {}
for (const name of Object.keys(globals.browser)) {
	disabledBrowserGlobals[name] = 'off'
}

// eslint-plugin-obsidianmd currently embeds @eslint/js/recommended without a
// files restriction. Scope it to JavaScript/TypeScript-family files so its
// JavaScript rules do not leak into ESLint language plugins such as JSON,
// Markdown, and CSS.
//
// Fail loudly if the upstream config shape changes instead of silently
// applying JavaScript rules to every language.
let foundJsRecommended = false
const obsidianRecommended = obsidianmd.configs.recommended.map(
	(config): Config => {
		if (config.name !== '@eslint/js/recommended') {
			return config
		}

		foundJsRecommended = true
		return {
			...config,
			files: codeFiles,
		}
	},
)

if (!foundJsRecommended) {
	throw new Error(
		'eslint-plugin-obsidianmd no longer exposes @eslint/js/recommended in the expected shape',
	)
}

// These plugins still publish ESLint 9-compatible rule types. Their runtime
// interfaces are exercised by `pnpm lint`; keep compatibility assertions at
// the declaration boundary while this project runs ESLint 10.
const solidConfig = solid as unknown as Config
const markdownPlugin = markdown as unknown as NonNullable<
	Config['plugins']
>[string]

const restrictedGlobals = obsidianRecommended
	.map((config) => config.rules?.['no-restricted-globals'])
	.filter((rule) => Array.isArray(rule))
	.at(-1)
if (
	!Array.isArray(restrictedGlobals) ||
	!restrictedGlobals.some(
		(option: unknown) =>
			typeof option === 'object' &&
			option !== null &&
			'name' in option &&
			option.name === 'fetch',
	)
) {
	throw new Error(
		'Expected an upstream fetch restriction for native fetch callers',
	)
}
const nativeFetchGlobals = restrictedGlobals
	.slice(1)
	.filter(
		(option: unknown) =>
			!(
				typeof option === 'object' &&
				option !== null &&
				'name' in option &&
				option.name === 'fetch'
			),
	)

export default defineConfig([
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'main.js',
			'styles.css',
			'coverage/**',
		],
	},

	...obsidianRecommended,

	// Providers explicitly opt into browser CORS/streaming. Image export avoids
	// requestUrl's mobile base64 bridge copies and resolves local resource URLs.
	// These two callers require native fetch; preserve all other restrictions.
	{
		files: [
			'src/ai/transport/provider-fetch.ts',
			'src/ai/chat/messages/export-session.ts',
		],
		rules: {
			'no-restricted-globals': ['error', ...nativeFetchGlobals],
		},
	},

	// Tooling executes in Node, not in Obsidian's browser-like runtime.
	{
		files: nodeFiles,
		languageOptions: {
			globals: {
				...disabledBrowserGlobals,
				...globals.node,
			},
		},
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
			'no-restricted-globals': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
			'obsidianmd/rule-custom-message': 'off',
		},
	},

	// Use one TypeScript project so all source files share ambient declarations.
	{
		files: typedFiles,
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: configDir,
			},
		},
		plugins: {
			'unused-imports': unusedImports,
		},
		rules: {
			'no-undef': 'off',

			// unused-imports handles both imports and variables without duplicate reports.
			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',

			'unused-imports/no-unused-imports': 'error',
			'unused-imports/no-unused-vars': [
				'error',
				{
					vars: 'all',
					varsIgnorePattern: '^_',
					args: 'after-used',
					argsIgnorePattern: '^_',
					caughtErrors: 'all',
					caughtErrorsIgnorePattern: '^_',
					ignoreRestSiblings: true,
				},
			],

			'@typescript-eslint/ban-ts-comment': 'error',
			'@typescript-eslint/no-explicit-any': [
				'error',
				{
					fixToUnknown: true,
				},
			],
		},
	},

	{
		...solidConfig,
		files: ['**/*.tsx'],
		rules: {
			...solidConfig.rules,
			// Core ESLint cannot see assignments performed by Solid JSX ref bindings.
			'no-unassigned-vars': 'off',
		},
	},

	// Tests intentionally trade some static strictness for practical mocking
	// and compatibility assertions.
	{
		files: testFiles,
		rules: {
			'@typescript-eslint/no-deprecated': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/await-thenable': 'off',
			'@typescript-eslint/no-unnecessary-type-assertion': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/only-throw-error': 'off',
			'@typescript-eslint/unbound-method': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/no-nodejs-modules': 'off',
			'obsidianmd/prefer-file-manager-trash-file': 'off',
		},
	},

	{
		files: [
			'src/components/McpServerEditorModal.ts',
			'src/components/ProviderEditorModal.ts',
		],
		rules: {
			// URL placeholders are machine-oriented examples, not prose UI labels.
			'obsidianmd/ui/sentence-case': 'off',
		},
	},

	{
		files: ['src/ai/chat/messages/ui-message.ts'],
		rules: {
			// Reads the deprecated field solely to migrate persisted legacy sessions.
			'@typescript-eslint/no-deprecated': 'off',
		},
	},

	// Strict JSON. package.json is excluded because obsidianmd already owns it;
	// tsconfig files use JSONC semantics below.
	{
		files: ['**/*.json'],
		ignores: ['package.json', ...tsconfigFiles],
		plugins: {
			json,
		},
		language: 'json/json',
		extends: ['json/recommended'],
	},

	// TypeScript config files are JSONC and officially permit trailing commas.
	{
		files: tsconfigFiles,
		plugins: {
			json,
		},
		language: 'json/jsonc',
		languageOptions: {
			allowTrailingCommas: true,
		},
		extends: ['json/recommended'],
	},

	{
		files: ['**/*.jsonc'],
		plugins: {
			json,
		},
		language: 'json/jsonc',
		extends: ['json/recommended'],
	},

	{
		files: ['**/*.json5'],
		plugins: {
			json,
		},
		language: 'json/json5',
		extends: ['json/recommended'],
	},

	// Obsidian Markdown commonly contains YAML frontmatter.
	{
		files: ['**/*.md'],
		plugins: {
			markdown: markdownPlugin,
		},
		language: 'markdown/gfm',
		languageOptions: {
			frontmatter: 'yaml',
		},
		extends: ['markdown/recommended'],
		rules: {
			'markdown/fenced-code-language': 'off',
			'markdown/no-missing-label-refs': 'off',
		},
	},

	{
		files: ['**/*.css'],
		plugins: {
			css,
		},
		language: 'css/css',
		extends: ['css/recommended'],
		rules: {
			// Obsidian/plugin styles intentionally use host-specific CSS features
			// outside the generic CSS validator's model.
			'css/no-invalid-at-rules': 'off',
			'css/no-invalid-properties': 'off',
			'css/no-important': 'error',
			'css/use-baseline': 'off',
		},
	},
])

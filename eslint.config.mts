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

export default defineConfig([
	{
		ignores: ['node_modules/**', 'dist/**', 'main.js', 'coverage/**'],
	},

	...obsidianRecommended,

	// Type-aware linting uses the repository's single root TypeScript project so
	// its ambient declarations are loaded together with every linted source file.
	{
		files: typedFiles,
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: configDir,
			},
		},
		rules: {
			// This rule mis-models detached elements created from an owner Document
			// and suggests Window helpers that are absent from Obsidian's Window type.
			'obsidianmd/prefer-create-el': 'off',
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

	// Solid owns TSX-specific semantics.
	{
		files: ['**/*.tsx'],
		...solidConfig,
	},

	// eslint-plugin-unused-imports owns the complete unused-declaration domain
	// for TypeScript files so imports are not reported twice.
	{
		files: typedFiles,
		plugins: {
			'unused-imports': unusedImports,
		},
		rules: {
			'no-undef': 'off',

			'@typescript-eslint/no-unused-vars': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-misused-promises': 'off',

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

	// Core ESLint cannot see assignments performed by Solid JSX ref bindings.
	{
		files: ['**/*.tsx'],
		rules: {
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
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
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
			'src/ai/chat/messages/export-session.ts',
			'src/ai/transport/provider-fetch.ts',
		],
		rules: {
			// These adapters need the Fetch response/stream contract; requestUrl does
			// not expose an equivalent interface.
			'no-restricted-globals': 'off',
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

	{
		files: ['src/polyfill.ts'],
		rules: {
			// This bootstrap must attach process to the host global in Node tests and
			// browser windows; the window-only recommendation cannot express that.
			'obsidianmd/no-global-this': 'off',
		},
	},

	{
		files: ['src/ai/tools/bash/fs.ts', 'src/utils/local-vault-io.ts'],
		rules: {
			// These reusable low-level adapters intentionally depend only on Vault;
			// callers that own an App use FileManager.trashFile directly.
			'obsidianmd/prefer-file-manager-trash-file': 'off',
		},
	},

	{
		files: ['src/settings/**/*.ts'],
		rules: {
			// The declarative settings API requires Obsidian 1.13, while this plugin
			// intentionally supports the declared 1.7.2 minimum.
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
			'obsidianmd/settings-tab/prefer-update-over-display': 'off',
		},
	},

	// package.json is already parsed and owned by eslint-plugin-obsidianmd's
	// recommended config. Only override its dependency policy here instead of
	// registering another @eslint/json plugin instance for the same file.
	{
		files: ['package.json'],
		rules: {
			'depend/ban-dependencies': [
				'error',
				{
					presets: ['native', 'microutilities', 'preferred'],
					allowed: [
						'builtin-modules',
						'dotenv',
						'eslint-plugin-import',
						'lodash-es',
					],
				},
			],
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
			'css/no-important': 'off',
			'css/use-baseline': 'off',
		},
	},
])

import css from '@eslint/css'
import js from '@eslint/js'
import json from '@eslint/json'
import markdown from '@eslint/markdown'
import * as tsParser from '@typescript-eslint/parser'
import solid from 'eslint-plugin-solid/configs/typescript'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
	{
		ignores: [
			'node_modules/**',
			'dist/**',
			'main.js',
			'coverage/**',
			'.codegraph/**',
		],
	},
	{
		files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
		plugins: { js },
		extends: ['js/recommended'],
		languageOptions: { globals: globals.browser },
	},
	{
		files: ['scripts/**/*.cjs', '*.mjs'],
		languageOptions: { globals: globals.node },
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
		},
	},
	// @ts-ignore
	{
		files: ['**/*.{ts,tsx}'],
		...solid,
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: 'tsconfig.json',
			},
		},
	},
	tseslint.configs.recommended,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
	{
		files: ['**/*.test.{ts,tsx}', 'test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
	{
		files: ['**/*.json'],
		ignores: ['tsconfig*.json'],
		plugins: { json },
		language: 'json/json',
		extends: ['json/recommended'],
	},
	{
		files: ['tsconfig*.json'],
		plugins: { json },
		language: 'json/jsonc',
		extends: ['json/recommended'],
	},
	{
		files: ['**/*.jsonc'],
		plugins: { json },
		language: 'json/jsonc',
		extends: ['json/recommended'],
	},
	{
		files: ['**/*.json5'],
		plugins: { json },
		language: 'json/json5',
		extends: ['json/recommended'],
	},
	{
		files: ['**/*.md'],
		plugins: { markdown },
		language: 'markdown/gfm',
		extends: ['markdown/recommended'],
		rules: {
			'markdown/no-missing-label-refs': 'off',
		},
	},
	{
		files: ['**/*.css'],
		plugins: { css },
		language: 'css/css',
		extends: ['css/recommended'],
		rules: {
			'css/no-invalid-at-rules': 'off',
			'css/no-invalid-properties': 'off',
			'css/no-important': 'off',
			'css/use-baseline': 'off',
		},
	},
	{
		files: ['scripts/**/*.cjs'],
		rules: {
			'@typescript-eslint/no-require-imports': 'off',
		},
	},
])

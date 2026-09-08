import dotenv from 'dotenv'
import esbuild from 'esbuild'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { createBuildPlugins } from './scripts/esbuild/plugins/index.mjs'

const pkgJson = JSON.parse(readFileSync('./package.json', 'utf-8'))
dotenv.config()

const prod = process.argv[2] === 'production'
process.env.NODE_ENV = prod ? 'production' : 'development'

const buildOptions = {
	entryPoints: ['src/index.ts'],
	bundle: true,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
	],
	define: {
		'process.env.NS_NSDAV_ENDPOINT': JSON.stringify(
			process.env.NS_NSDAV_ENDPOINT,
		),
		'process.env.NS_DAV_ENDPOINT': JSON.stringify(process.env.NS_DAV_ENDPOINT),
		'process.env.LLM_GATEWAY_CLIENT_ID': JSON.stringify(
			process.env.LLM_GATEWAY_CLIENT_ID || '',
		),
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || ''),
		'process.env.PLUGIN_VERSION': JSON.stringify(pkgJson.version),
	},
	format: 'cjs',
	target: 'es2018',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: prod ? 'dist/main.js' : 'main.js',
	write: false,
	metafile: !prod,
	minify: prod,
	platform: 'browser',
	plugins: createBuildPlugins({ prod }),
	alias: {
		localforage: './node_modules/localforage/dist/localforage.nopromises.js',
		'node:zlib': './src/shims/node-zlib.ts',
	},
}

if (prod) {
	await esbuild.build(buildOptions)
} else {
	const context = await esbuild.context(buildOptions)
	await context.watch()
}

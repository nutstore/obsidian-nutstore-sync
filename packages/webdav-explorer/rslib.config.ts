import { pluginBabel } from '@rsbuild/plugin-babel'
import { pluginSolid } from '@rsbuild/plugin-solid'
import { defineConfig } from '@rslib/core'

export default defineConfig({
	source: {
		entry: {
			index: ['./src/**'],
		},
	},
	tools: {
		rspack: {
			plugins: [],
		},
	},
	lib: [
		{
			bundle: false,
			dts: true,
			format: 'esm',
		},
	],
	output: {
		target: 'web',
	},
	plugins: [
		pluginBabel({
			include: /\.(?:jsx|tsx)$/,
		}),
		pluginSolid(),
	],
})

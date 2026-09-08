import solid from 'unplugin-solid/esbuild'
import { postcssPlugin } from './postcss.mjs'
import { rawTextPlugin } from './raw-text.mjs'
import { createOutputFinalizer } from './output-finalizer.mjs'

export function createBuildPlugins({ prod }) {
	return [
		rawTextPlugin,
		postcssPlugin,
		solid(),
		createOutputFinalizer({ prod }),
	]
}

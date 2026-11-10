import solid from 'unplugin-solid/esbuild'
import { postcssPlugin } from './postcss.mjs'
import { compressedAssetsPlugin } from './compressed-assets.mjs'
import { createOutputFinalizer } from './output-finalizer.mjs'

export function createBuildPlugins({ prod, analyze }) {
	return [
		compressedAssetsPlugin({ prod }),
		postcssPlugin,
		solid(),
		createOutputFinalizer({ prod, analyze }),
	]
}

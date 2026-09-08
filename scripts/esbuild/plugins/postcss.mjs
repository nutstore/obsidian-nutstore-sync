import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

export const postcssPlugin = {
	name: 'postcss',
	setup(build) {
		build.onResolve({ filter: /\.css$/ }, (args) => ({
			path: path.resolve(args.resolveDir, args.path),
			namespace: 'postcss',
			pluginData: {
				resolveDir: args.resolveDir || process.cwd(),
				importer: args.importer,
			},
		}))

		build.onLoad({ filter: /\.css$/, namespace: 'postcss' }, async (args) => {
			const css = await fs.promises.readFile(args.path, 'utf8')
			return {
				contents: css,
				loader: 'css',
				watchFiles: [args.path, './uno.config.ts'],
				resolveDir: args.pluginData?.resolveDir,
			}
		})
	},
}

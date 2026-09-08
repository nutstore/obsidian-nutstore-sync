import fs from 'node:fs'
import path from 'node:path'

export const rawTextPlugin = {
	name: 'raw-text',
	setup(build) {
		build.onResolve({ filter: /\.(?:md|svg)\?raw$/ }, (args) => ({
			path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
			namespace: 'raw-text',
		}))
		build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
			contents: await fs.promises.readFile(args.path, 'utf8'),
			loader: 'text',
			watchFiles: [args.path],
		}))
	},
}

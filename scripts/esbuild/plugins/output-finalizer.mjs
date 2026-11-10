import fs from 'node:fs'
import path from 'node:path'
import { analyzeMetafile } from 'esbuild'
import { finalizeUnoCss, readDevelopmentUnoSource } from './unocss.mjs'

function findOutputFile(outputFiles, name) {
	return outputFiles.find(
		(outputFile) => path.basename(outputFile.path) === name,
	)
}

export function createOutputFinalizer({ prod, analyze }) {
	const jsPath = path.resolve(prod ? './dist/main.js' : './main.js')
	const cssPath = path.resolve('./styles.css')
	const metafilePath = analyze ? path.resolve('./dist/meta.json') : undefined

	return {
		name: 'finalize-output',
		setup(build) {
			build.onEnd(async (result) => {
				if (result.errors.length > 0) return

				const outputFiles = result.outputFiles ?? []
				const jsOutput = findOutputFile(outputFiles, 'main.js')
				const cssOutput = findOutputFile(outputFiles, 'main.css')
				if (!jsOutput || !cssOutput) {
					throw new Error(
						'Expected esbuild to produce main.js and main.css in memory.',
					)
				}

				let js = jsOutput.text
				if (prod) {
					const { injectSourcePolyfills } =
						await import('./source-polyfills.mjs')
					const polyfillResult = await injectSourcePolyfills(js, { prod })
					js = polyfillResult.source
					if (polyfillResult.modules.length > 0) {
						console.info(
							`Injected ${polyfillResult.modules.length} source-selected core-js polyfills.`,
						)
					}
				}

				const scanSource = prod
					? undefined
					: await readDevelopmentUnoSource(result.metafile)
				const finalized = await finalizeUnoCss({
					js,
					css: cssOutput.text,
					prod,
					cssPath,
					scanSource,
				})

				await fs.promises.mkdir(path.dirname(jsPath), { recursive: true })
				await Promise.all([
					fs.promises.writeFile(jsPath, finalized.js),
					fs.promises.writeFile(cssPath, finalized.css),
				])

				if (metafilePath && result.metafile) {
					await fs.promises.mkdir(path.dirname(metafilePath), {
						recursive: true,
					})
					await fs.promises.writeFile(
						metafilePath,
						JSON.stringify(result.metafile),
					)
					console.info(
						await analyzeMetafile(result.metafile, {
							verbose: analyze === 'analyze:verbose',
						}),
					)
					console.info(`metafile: ${metafilePath}`)
				}
			})
		},
	}
}

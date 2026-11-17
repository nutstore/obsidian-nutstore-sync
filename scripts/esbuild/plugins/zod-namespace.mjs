import { readFile } from 'node:fs/promises'
import path from 'node:path'

// `zod` exports `z` as an ordinary object that contains `locales`. Importing
// that object by name forces bundlers to keep every property because the
// object can escape. Importing the module namespace instead keeps the same
// property access (`z.object`, `z.locales`) while letting esbuild resolve
// statically used exports and drop the unused locale modules.
const zodSpecifier = String.raw`zod(?:\/(?:v4|mini|v4-mini))?`
const namedZImport = new RegExp(
	String.raw`\bimport\s*\{\s*z(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*,?\s*\}\s*from\s*(["'])(${zodSpecifier})\2;?`,
	'g',
)
const remainingNamedZImport = new RegExp(
	String.raw`\bimport\s*\{[^}]*\bz\b[^}]*\}\s*from\s*["']${zodSpecifier}["']`,
)

/**
 * Rewrites named `z` imports from zod to namespace imports. All current call
 * sites only use static properties, so this is behavior-preserving and gives
 * esbuild enough information to tree-shake unused exports.
 */
export function rewriteZodNamespaceImports(source) {
	return source.replace(namedZImport, (_match, alias, quote, specifier) => {
		const name = alias || 'z'
		return `import * as ${name} from ${quote}${specifier}${quote}`
	})
}

/**
 * AI SDK providers import `{ z }` from `zod/v4` in their published bundles.
 * Their sources are not ours to edit, so rewrite those imports while loading
 * them. A named import shape we do not understand fails the build instead of
 * silently keeping all locale modules.
 */
export function zodNamespaceImportPlugin() {
	return {
		name: 'zod-namespace-import',
		setup(build) {
			build.onLoad(
				{ filter: /node_modules[\\/]@ai-sdk[\\/].*\.(?:mjs|cjs|js)$/ },
				async (args) => {
					const source = await readFile(args.path, 'utf8')
					const contents = rewriteZodNamespaceImports(source)
					if (remainingNamedZImport.test(contents)) {
						throw new Error(
							`Unsupported zod named z import in ${args.path}. ` +
								'Extend the rewrite so zod locales stay tree-shakable.',
						)
					}
					if (contents === source) return undefined
					return {
						contents,
						loader: 'js',
						resolveDir: path.dirname(args.path),
						watchFiles: [args.path],
					}
				},
			)
		},
	}
}

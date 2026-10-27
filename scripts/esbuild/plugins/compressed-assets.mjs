import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateAsync } from '@gfx/zopfli'

const runtimeId = 'compressed-assets:runtime'
const base91Alphabet =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#$%&()*+,./:;<=>?@[]^_`{|}~"'
const runtime = `
import { inflateSync, strFromU8 } from 'fflate/browser';
const alphabet = ${JSON.stringify(base91Alphabet)};
export function decode(encoded) {
	let bits = 0, bitCount = 0, value = -1;
	let byteCount = 0;
	const bytes = new Uint8Array(Math.ceil(encoded.length * 14 / 8));
	for (let i = 0; i < encoded.length; i++) {
		const digit = alphabet.indexOf(encoded[i]);
		if (value < 0) value = digit;
		else {
			value += digit * 91;
			bits |= value << bitCount;
			bitCount += (value & 8191) > 88 ? 13 : 14;
			do {
				bytes[byteCount++] = bits & 255;
				bits >>= 8;
				bitCount -= 8;
			} while (bitCount > 7);
			value = -1;
		}
	}
	if (value >= 0) bytes[byteCount++] = (bits | value << bitCount) & 255;
	return strFromU8(inflateSync(bytes.subarray(0, byteCount)));
}
`

/** @param {Uint8Array} bytes */
function encodeBase91(bytes) {
	let bits = 0
	let bitCount = 0
	let encoded = ''
	for (const byte of bytes) {
		bits |= byte << bitCount
		bitCount += 8
		if (bitCount <= 13) continue
		let value = bits & 8191
		if (value > 88) {
			bits >>= 13
			bitCount -= 13
		} else {
			value = bits & 16383
			bits >>= 14
			bitCount -= 14
		}
		encoded += base91Alphabet[value % 91]
		encoded += base91Alphabet[Math.floor(value / 91)]
	}
	if (bitCount) {
		encoded += base91Alphabet[bits % 91]
		if (bitCount > 7 || bits > 90)
			encoded += base91Alphabet[Math.floor(bits / 91)]
	}
	return encoded
}

/**
 * Keep compression a build detail: imports stay synchronous and decoding uses
 * only WebView APIs. Limit JSON interception to project assets so dependency
 * JSON retains esbuild's field-level tree shaking. Development keeps source
 * readable. Tiny assets keep the native loader when compression cannot pay
 * for its module wrapper; the shared decoder is bundled only when used.
 *
 * @param {{ prod: boolean, sourceRoot?: string }} options
 * @returns {import('esbuild').Plugin}
 */
export function compressedAssetsPlugin({
	prod,
	sourceRoot = path.resolve('src'),
}) {
	const root = path.resolve(sourceRoot)
	return {
		name: 'compressed-assets',
		setup(build) {
			build.onResolve({ filter: /\.(?:md|svg)\?raw$/ }, (args) => ({
				path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
				namespace: 'raw-text',
				sideEffects: false,
			}))
			build.onResolve({ filter: /^compressed-assets:runtime$/ }, () => ({
				path: runtimeId,
				namespace: 'compressed-assets',
			}))
			build.onLoad({ filter: /.*/, namespace: 'compressed-assets' }, () => ({
				contents: runtime,
				loader: 'js',
				resolveDir: path.dirname(fileURLToPath(import.meta.url)),
			}))

			/**
			 * @param {import('esbuild').OnLoadArgs} args
			 * @returns {Promise<import('esbuild').OnLoadResult | undefined>}
			 */
			async function load(args) {
				const json = args.namespace === 'file'
				if (json && (!prod || !args.path.startsWith(root + path.sep))) return
				const source = await fs.readFile(args.path, 'utf8')
				/** @type {import('esbuild').OnLoadResult} */
				const original = {
					contents: source,
					loader: json ? 'json' : 'text',
					watchFiles: [args.path],
				}
				if (!prod) return original
				const value = json ? JSON.parse(source.replace(/^\uFEFF/, '')) : source
				const text = json ? JSON.stringify(value) : source
				const compressed = await deflateAsync(Buffer.from(text), {
					numiterations: 15,
				})
				const encoded = encodeBase91(compressed)
				const literal = JSON.stringify(encoded)
				if (literal.length + 254 >= Buffer.byteLength(text)) return original

				let contents = `import { decode } from '${runtimeId}';\nconst data = /* @__PURE__ */ ${json ? 'JSON.parse(/* @__PURE__ */ decode(' : 'decode('}${literal}${json ? '))' : ')'};\nexport default data;\n`
				// Match JSON loader named exports, including reserved-word keys.
				// All exports reference the same parsed object (no duplicated state).
				if (
					json &&
					value !== null &&
					typeof value === 'object' &&
					!Array.isArray(value)
				) {
					for (const [index, key] of Object.keys(value).entries()) {
						if (
							key !== 'default' &&
							/^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(key)
						) {
							contents += `const field${index} = data[${JSON.stringify(key)}]; export { field${index} as ${key} };\n`
						}
					}
				}
				return { contents, loader: 'js', watchFiles: [args.path] }
			}
			build.onLoad({ filter: /.*/, namespace: 'raw-text' }, load)
			build.onLoad({ filter: /\.json$/, namespace: 'file' }, load)
		},
	}
}

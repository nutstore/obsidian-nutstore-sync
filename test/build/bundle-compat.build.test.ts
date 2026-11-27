import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const BUNDLE_PATH = resolve(ROOT, 'main.js')

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

describe('Production bundle WebView compatibility smoke test', () => {
	it('evaluates main.js inside a restricted browser-like VM without Node built-ins', async () => {
		const exists = await fileExists(BUNDLE_PATH)
		if (!exists) {
			if (process.env.CI) {
				throw new Error(
					`Expected built production bundle at ${BUNDLE_PATH} in CI before running test:build`,
				)
			}
			// Skip cleanly when main.js has not been built yet locally; CI builds before test:build.
			return
		}

		const source = await readFile(BUNDLE_PATH, 'utf8')
		expect(source.length).toBeGreaterThan(1024)

		const requiredModules: string[] = []
		const fakeObsidian = {
			Plugin: class {},
			PluginSettingTab: class {},
			ItemView: class {},
			MarkdownView: class {},
			Modal: class {},
			FuzzySuggestModal: class {},
			AbstractInputSuggest: class {},
			Setting: class {},
			Notice: class {},
			Component: class {},
			Events: class {},
			TFile: class {},
			TFolder: class {},
			TAbstractFile: class {},
			Platform: {
				isDesktop: false,
				isMobile: true,
				isDesktopApp: false,
				isMobileApp: true,
				isIosApp: true,
				isAndroidApp: false,
			},
			normalizePath: (p: string) => p,
			setIcon: () => {},
			addIcon: () => {},
			removeIcon: () => {},
			requestUrl: async () => ({
				status: 200,
				text: '',
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
			}),
			debounce: <T>(fn: T) => fn,
			moment: Object.assign(() => ({ format: () => '' }), {
				locale: () => 'en',
			}),
			requireApiVersion: () => true,
		}

		const fakeModule = { exports: {} as Record<string, unknown> }
		const fakeWindow: Record<string, unknown> = {
			location: new URL('app://obsidian.md/'),
			navigator: {
				userAgent:
					'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15',
				language: 'en-US',
				languages: ['en-US'],
			},
			addEventListener: () => {},
			removeEventListener: () => {},
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
			queueMicrotask,
			URL,
			URLSearchParams,
			TextEncoder,
			TextDecoder,
			Blob,
			DOMException,
			FormData,
			MessageChannel,
			structuredClone,
			AbortController,
			AbortSignal,
			Event,
			CustomEvent,
			EventTarget,
			fetch: globalThis.fetch,
			Headers,
			Request,
			Response,
			ReadableStream,
			WritableStream,
			TransformStream,
			crypto: globalThis.crypto,
			atob: globalThis.atob,
			btoa: globalThis.btoa,
			performance: globalThis.performance,
			console,
			document: {
				documentElement: { style: {} },
				addEventListener: () => {},
				removeEventListener: () => {},
				createElement: () => ({
					style: {},
					setAttribute: () => {},
					appendChild: () => {},
				}),
				head: { appendChild: () => {} },
				body: { appendChild: () => {} },
			},
		}
		fakeWindow.window = fakeWindow
		fakeWindow.self = fakeWindow
		fakeWindow.globalThis = fakeWindow

		// Intentionally withhold Node globals (`process`, `Buffer`, `global`) and reject
		// any `require(...)` outside the host-provided `obsidian` / `@codemirror/*` boundary.
		const ALLOWED_EXTERNALS = new Set([
			'obsidian',
			'@codemirror/state',
			'@codemirror/view',
			'@codemirror/autocomplete',
			'@codemirror/commands',
			'@codemirror/language',
		])

		const sandboxRequire = (id: string) => {
			requiredModules.push(id)
			if (id === 'obsidian') return fakeObsidian
			if (id === '@codemirror/state') {
				return {
					StateEffect: { define: () => ({ of: () => ({}) }) },
					StateField: { define: () => ({}) },
					RangeSetBuilder: class {},
					Prec: {
						highest: (x: unknown) => x,
						high: (x: unknown) => x,
						low: (x: unknown) => x,
					},
				}
			}
			if (id === '@codemirror/view') {
				return {
					Decoration: { mark: () => ({}), set: () => ({}), none: {} },
					EditorView: {
						decorations: { from: () => ({}) },
						updateListener: { of: () => ({}) },
						baseTheme: () => ({}),
						theme: () => ({}),
						domEventHandlers: () => ({}),
					},
					ViewPlugin: { fromClass: () => ({}) },
					WidgetType: class {},
				}
			}
			if (ALLOWED_EXTERNALS.has(id)) return {}
			throw new Error(`Forbidden Node/host require in WebView bundle: "${id}"`)
		}

		const context = vm.createContext({
			...fakeWindow,
			module: fakeModule,
			exports: fakeModule.exports,
			require: sandboxRequire,
		})

		vm.runInContext(source, context, { filename: 'main.js', timeout: 10_000 })

		const exported = fakeModule.exports.default ?? fakeModule.exports
		expect(typeof exported).toBe('function')
		for (const id of requiredModules) {
			expect(ALLOWED_EXTERNALS.has(id)).toBe(true)
		}
	})
})

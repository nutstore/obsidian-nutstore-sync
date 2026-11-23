import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { LogLevels } from 'consola'
import logger from '~/utils/logger'

if (!globalThis.crypto) {
	globalThis.crypto = webcrypto as Crypto
}

/**
 * In Node-environment tests (unit & sim), Obsidian host modules still reference
 * `window.setTimeout` / `window.clearTimeout` (mandated by eslint-plugin-obsidianmd)
 * and transitive imports of Solid components call `solid-js/web`'s top-level
 * `delegateEvents(..., window.document)`.
 *
 * Provide a minimal dynamic proxy when running outside JSDOM so pure-logic tests
 * never pay the 500ms-per-file JSDOM environment boot tax while still honoring
 * `vi.useFakeTimers()`.
 */
if (typeof window === 'undefined') {
	const minimalDocument = {
		addEventListener: () => {},
		removeEventListener: () => {},
	}
	const nodeWindow = {
		document: minimalDocument,
		setTimeout: (
			handler: (...args: unknown[]) => void,
			timeout?: number,
			...args: unknown[]
		) => globalThis.setTimeout(handler, timeout, ...args),
		clearTimeout: (id?: ReturnType<typeof setTimeout>) =>
			globalThis.clearTimeout(id),
		setInterval: (
			handler: (...args: unknown[]) => void,
			timeout?: number,
			...args: unknown[]
		) => globalThis.setInterval(handler, timeout, ...args),
		clearInterval: (id?: ReturnType<typeof setInterval>) =>
			globalThis.clearInterval(id),
		queueMicrotask: (callback: VoidFunction) =>
			globalThis.queueMicrotask(callback),
		addEventListener: () => {},
		removeEventListener: () => {},
		location: { href: 'app://obsidian.md/', protocol: 'app:' },
		navigator: { userAgent: 'ObsidianTestNode' },
		get fetch() {
			return globalThis.fetch
		},
		set fetch(value: typeof globalThis.fetch) {
			globalThis.fetch = value
		},
		get indexedDB() {
			return globalThis.indexedDB
		},
		get IDBKeyRange() {
			return globalThis.IDBKeyRange
		},
		crypto: globalThis.crypto,
		performance: globalThis.performance,
	}
	Object.defineProperty(globalThis, 'window', {
		value: nodeWindow,
		configurable: true,
		writable: true,
	})
}

logger.level = LogLevels.silent

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
})

describe('polyfill', () => {
	it('adds process.env when it is missing', async () => {
		const process: { cwd: () => string; env?: Record<string, string> } = {
			cwd() {
				return '/mobile'
			},
		}

		vi.stubGlobal('window', { process, queueMicrotask, setTimeout })
		vi.resetModules()
		await import('./polyfill')

		expect(process).toBeDefined()
		expect(typeof process.cwd).toBe('function')
		expect(process.cwd()).toBe('/mobile')
		expect(process.env).toEqual({})
	})

	it('adds queueMicrotask when it is missing', async () => {
		const runtime = {
			process: { cwd: () => '/' },
			setTimeout,
			queueMicrotask: undefined as typeof queueMicrotask | undefined,
		}
		vi.stubGlobal('window', runtime)

		vi.resetModules()
		await import('./polyfill')

		const callback = vi.fn()
		runtime.queueMicrotask!(() => callback('Hello 你好 🌿'))
		await Promise.resolve()

		expect(callback).toHaveBeenCalledOnce()
		expect(callback).toHaveBeenCalledWith('Hello 你好 🌿')
	})
})

import { afterEach, describe, expect, it, vi } from 'vitest'

const originalProcess = globalThis.process
const originalQueueMicrotask = globalThis.queueMicrotask

afterEach(() => {
	globalThis.process = originalProcess
	globalThis.queueMicrotask = originalQueueMicrotask
	vi.resetModules()
})

describe('polyfill', () => {
	it('adds process.env when it is missing', async () => {
		;(globalThis as typeof globalThis & { process: any }).process = {
			cwd() {
				return '/mobile'
			},
		}

		vi.resetModules()
		await import('./polyfill')

		expect(globalThis.process).toBeDefined()
		expect(typeof globalThis.process.cwd).toBe('function')
		expect(globalThis.process.cwd()).toBe('/mobile')
		expect(globalThis.process.env).toEqual({})
	})

	it('adds queueMicrotask when it is missing', async () => {
		;(globalThis as { queueMicrotask?: typeof queueMicrotask }).queueMicrotask =
			undefined

		vi.resetModules()
		await import('./polyfill')

		const callback = vi.fn()
		globalThis.queueMicrotask(() => callback('Hello 你好 🌿'))
		await Promise.resolve()

		expect(callback).toHaveBeenCalledOnce()
		expect(callback).toHaveBeenCalledWith('Hello 你好 🌿')
	})
})

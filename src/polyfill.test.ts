import { afterEach, describe, expect, it, vi } from 'vitest'
import { deflateSync, gzipSync, zlibSync } from 'fflate'

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

	it.each([
		['deflate-raw', deflateSync],
		['deflate', zlibSync],
		['gzip', gzipSync],
	] as const)(
		'fills DecompressionStream(%s) on WebViews without it',
		async (format, compress) => {
			const runtime = {
				process: { cwd: () => '/' },
				queueMicrotask,
				setTimeout,
				TransformStream,
				DecompressionStream: undefined as
					typeof DecompressionStream | undefined,
			}
			vi.stubGlobal('window', runtime)
			vi.resetModules()
			await import('./polyfill')

			const text = 'Neutral archive / 中性归档 🌱 '.repeat(64)
			const compressed = compress(new TextEncoder().encode(text))
			const input = new Blob([compressed.slice(0, 7), compressed.slice(7)])
			const output = input
				.stream()
				.pipeThrough(new runtime.DecompressionStream!(format))
			expect(await new Response(output).text()).toBe(text)
		},
	)

	it('keeps the native DecompressionStream when it supports every format', async () => {
		const runtime = {
			process: { cwd: () => '/' },
			queueMicrotask,
			setTimeout,
			TransformStream,
			DecompressionStream,
		}
		vi.stubGlobal('window', runtime)
		vi.resetModules()
		await import('./polyfill')
		expect(runtime.DecompressionStream).toBe(DecompressionStream)
	})
})

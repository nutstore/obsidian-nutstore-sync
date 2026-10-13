import { describe, expect, it, vi } from 'vitest'
import {
	ModuleLifecycle,
	ModuleScope,
	ModuleState,
	normalizeModuleState,
} from './lifecycle'
import { guardIO } from './guard-io'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('module lifetime', () => {
	it('defaults old or invalid settings to enabled and preserves explicit disabling', () => {
		for (const value of [undefined, null, true, '', '中性 neutral 🌱'])
			expect(normalizeModuleState(value)).toBe(ModuleState.Enabled)
		expect(normalizeModuleState(ModuleState.Disabled)).toBe(
			ModuleState.Disabled,
		)
	})

	it('does not start a cold disabled module and registers each activation only once', async () => {
		const start = vi.fn()
		const dispose = vi.fn()
		const stop = vi.fn()
		const lifecycle = new ModuleLifecycle((scope) => {
			start()
			scope.register(dispose)
		}, stop)
		await lifecycle.update(false)
		expect(start).not.toHaveBeenCalled()
		await Promise.all([lifecycle.update(true), lifecycle.update(true)])
		expect(start).toHaveBeenCalledTimes(1)
		const previous = lifecycle.scope
		await Promise.all([lifecycle.update(false), lifecycle.update(false)])
		expect(dispose).toHaveBeenCalledTimes(1)
		expect(stop).toHaveBeenCalledTimes(1)
		await lifecycle.update(true)
		expect(start).toHaveBeenCalledTimes(2)
		expect(() => previous.check()).toThrow()
		expect(() => lifecycle.scope.check()).not.toThrow()
	})

	it('revokes synchronously and waits for retirement before a rapid re-enable', async () => {
		const retired = deferred<void>()
		const start = vi.fn()
		const lifecycle = new ModuleLifecycle(start, () => retired.promise)
		await lifecycle.update(true)
		const previous = lifecycle.scope
		const stopping = lifecycle.update(false)
		expect(previous.signal.aborted).toBe(true)
		expect(lifecycle.active).toBe(false)
		const restarting = lifecycle.update(true)
		await Promise.resolve()
		expect(start).toHaveBeenCalledTimes(1)
		retired.resolve()
		await Promise.all([stopping, restarting])
		expect(start).toHaveBeenCalledTimes(2)
		expect(lifecycle.scope).not.toBe(previous)
	})

	it('a disable during retirement wins over a queued activation', async () => {
		const retired = deferred<void>()
		const start = vi.fn()
		const lifecycle = new ModuleLifecycle(start, () => retired.promise)
		await lifecycle.update(true)
		const requests = [
			lifecycle.update(false),
			lifecycle.update(true),
			lifecycle.update(false),
		]
		retired.resolve()
		await Promise.all(requests)
		expect(lifecycle.active).toBe(false)
		expect(start).toHaveBeenCalledTimes(1)
	})

	it.each(['notes/neutral.md', '笔记/中性🌱.md'])(
		'rejects late I/O and stale clients for %s',
		async (path) => {
			const response = deferred<string>()
			const raw = {
				read: vi.fn(() => response.promise),
				write: vi.fn((_path: string, _content: string) => {}),
			}
			const scope = new ModuleScope()
			const io = guardIO(raw, scope.check)
			const result = io.read().then((content) => io.write(path, content))
			const rejected = expect(result).rejects.toMatchObject({
				name: 'AbortError',
			})
			scope.close()
			response.resolve('Neutral content / 中性内容 🌱')
			await rejected
			expect(raw.write).not.toHaveBeenCalled()
			expect(() => io.read()).toThrow()
		},
	)

	it('cancels a pending response immediately and suppresses cancellation reports', async () => {
		const pending = deferred<string>()
		const scope = new ModuleScope()
		const report = vi.fn()
		const commit = vi.fn()
		const background = scope.background(async () => {
			commit(await scope.wait(pending.promise))
		}, report)
		scope.close()
		pending.resolve('中性 response 🌱')
		await background
		expect(commit).not.toHaveBeenCalled()
		expect(report).not.toHaveBeenCalled()
	})
	it('drains submitted writes before another activation can start', async () => {
		const pending = deferred<void>()
		const start = vi.fn()
		const lifecycle = new ModuleLifecycle(start, () => {})
		await lifecycle.update(true)
		const scope = lifecycle.scope
		const io = guardIO(
			{ write: () => pending.promise },
			scope.check,
			scope.track,
		)
		const write = io.write()
		const rejected = expect(write).rejects.toMatchObject({ name: 'AbortError' })
		const stopping = lifecycle.update(false)
		const restarting = lifecycle.update(true)
		await Promise.resolve()
		expect(start).toHaveBeenCalledTimes(1)
		pending.resolve()
		await Promise.all([rejected, stopping, restarting])
		expect(start).toHaveBeenCalledTimes(2)
	})

	it('cleans partial activation even when startup throws', async () => {
		const dispose = vi.fn()
		const stop = vi.fn()
		let activation: ModuleScope | undefined
		const lifecycle = new ModuleLifecycle((scope) => {
			activation = scope
			scope.register(dispose)
			throw new Error('Neutral startup failure / 中性启动失败 🌱')
		}, stop)
		await expect(lifecycle.update(true)).rejects.toThrow('startup failure')
		expect(activation?.signal.aborted).toBe(true)
		expect(lifecycle.active).toBe(false)
		expect(dispose).toHaveBeenCalledOnce()
		expect(stop).toHaveBeenCalledOnce()
	})
})

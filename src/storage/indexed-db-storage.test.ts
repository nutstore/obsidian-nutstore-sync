import 'fake-indexeddb/auto'
import { IDBDatabase } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIndexedDbStorage } from './indexed-db-storage'

afterEach(() => vi.restoreAllMocks())

describe('IndexedDB recovery with localforage', () => {
	it.each([
		'Connection to Indexed Database server lost. Refresh the page to try again',
		'数据库连接中断 📚',
		'',
	])(
		'reopens shared connections regardless of message: %s',
		async (message) => {
			const name = `recovery-${crypto.randomUUID()}`
			const first = createIndexedDbStorage<string>(name, 'first')
			const second = createIndexedDbStorage<string>(name, 'second')
			await first.set('note/笔记📚', 'Example 示例🌱')
			await second.set('record/记录🌱', 'Saved 已保存📚')
			const close = vi.spyOn(IDBDatabase.prototype, 'close')
			const open = vi.spyOn(indexedDB, 'open')
			vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(
				() => {
					throw new DOMException(message, 'UnknownError')
				},
			)
			expect(await first.get('note/笔记📚')).toBe('Example 示例🌱')
			expect(close).toHaveBeenCalled()
			expect(open).toHaveBeenCalled()
			expect(await second.get('record/记录🌱')).toBe('Saved 已保存📚')
			await second.set('new/新建✨', 'Updated 更新✨')
			expect(await second.get('new/新建✨')).toBe('Updated 更新✨')
		},
	)

	it.each(['QuotaExceededError', 'DataCloneError', 'ConstraintError'])(
		'does not reconnect for %s',
		async (name) => {
			const storage = createIndexedDbStorage<string>(
				crypto.randomUUID(),
				'notes',
			)
			await storage.set('note/笔记📚', 'Example 示例🌱')
			const open = vi.spyOn(indexedDB, 'open')
			const error = new DOMException('Example 示例🌱', name)
			vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(
				() => {
					throw error
				},
			)
			await expect(storage.set('note/笔记📚', 'Updated 更新✨')).rejects.toBe(
				error,
			)
			expect(open).not.toHaveBeenCalled()
			expect(await storage.get('note/笔记📚')).toBe('Example 示例🌱')
		},
	)

	it.each([
		'UnknownError An internal error was encountered in the Indexed Database server',
		'数据库服务暂不可用 📚',
		'',
	])(
		'recovers aborted reads and writes regardless of message: %s',
		async (message) => {
			const storage = createIndexedDbStorage<string>(
				crypto.randomUUID(),
				'notes',
			)
			await storage.set('note/笔记📚', 'Example 示例🌱')
			const close = vi.spyOn(IDBDatabase.prototype, 'close')
			const open = vi.spyOn(indexedDB, 'open')
			const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction')
			const abort = () => {
				throw new DOMException(message, 'AbortError')
			}
			transaction.mockImplementationOnce(abort)
			expect(await storage.get('note/笔记📚')).toBe('Example 示例🌱')
			expect(close).toHaveBeenCalled()
			expect(open).toHaveBeenCalledTimes(1)
			close.mockClear()
			open.mockClear()
			transaction.mockImplementationOnce(abort)
			await expect(storage.set('note/笔记📚', 'Updated 更新✨')).resolves.toBe(
				'Updated 更新✨',
			)
			expect(close).toHaveBeenCalled()
			expect(open).toHaveBeenCalledTimes(1)
			expect(await storage.get('note/笔记📚')).toBe('Updated 更新✨')
		},
	)

	it.each(['UnknownError', 'AbortError'])(
		'bounds recovery when the service remains unavailable: %s',
		async (name) => {
			const storage = createIndexedDbStorage<string>(
				crypto.randomUUID(),
				'notes',
			)
			await storage.set('note/笔记📚', 'Example 示例🌱')
			const error = new DOMException('Unavailable 暂不可用🌱', name)
			const transaction = vi
				.spyOn(IDBDatabase.prototype, 'transaction')
				.mockImplementation(() => {
					throw error
				})
			await expect(storage.get('note/笔记📚')).rejects.toBe(error)
			expect(transaction).toHaveBeenCalledTimes(2)
		},
	)
})

import { describe, expect, it } from 'vitest'
import type { LogEntry } from '~/services/logger.service'
import logsStringify from './logs-stringify'

function makeEntry(
	level: string,
	args: any[],
	timestamp = '2026-06-16 14:30:01',
): LogEntry {
	return { timestamp, level, args }
}

describe('logsStringify', () => {
	describe('output format', () => {
		it('formats a structured log entry as [timestamp] [level] args', () => {
			const result = logsStringify(makeEntry('info', ['hello world']))
			expect(result).toBe('[2026-06-16 14:30:01] [info] hello world')
		})

		it('joins multiple args with space', () => {
			const result = logsStringify(makeEntry('debug', ['part one', 'part two']))
			expect(result).toBe('[2026-06-16 14:30:01] [debug] part one part two')
		})

		it('preserves string args verbatim (no extra quotes)', () => {
			const result = logsStringify(makeEntry('info', ['plain string']))
			expect(result).toContain('plain string')
			// Must NOT add JSON quotes around the string arg
			expect(result).not.toContain('"plain string"')
		})
	})

	describe('Error serialization — the critical path', () => {
		it('includes error message in output', () => {
			const err = new Error('upload failed')
			const result = logsStringify(
				makeEntry('error', ['[PushTask] failed:', err]),
			)!
			expect(result).toContain('[PushTask] failed:')
			expect(result).toContain('upload failed')
		})

		it('includes full stack trace', () => {
			const err = new Error('stack test')
			const result = logsStringify(makeEntry('error', [err]))!
			// stack includes the message AND call frames
			expect(result).toContain('stack test')
			expect(result).toMatch(/at .+\(?.+:\d+/)
		})

		it('does NOT produce {} for Error objects', () => {
			const err = new Error('should not be empty')
			const result = logsStringify(makeEntry('error', [err]))!
			expect(result).not.toContain('{}')
			expect(result).toContain('should not be empty')
		})

		it('handles TypeError, RangeError, and custom subclasses', () => {
			class CustomError extends Error {
				constructor(msg: string) {
					super(msg)
					this.name = 'CustomError'
				}
			}
			expect(
				logsStringify(makeEntry('error', [new TypeError('type err')])),
			).toContain('type err')
			expect(
				logsStringify(makeEntry('error', [new RangeError('range err')])),
			).toContain('range err')
			expect(
				logsStringify(makeEntry('error', [new CustomError('custom')])),
			).toContain('custom')
		})

		it('falls back to name: message when stack is absent', () => {
			const err = new Error('no stack here')
			delete (err as any).stack
			const result = logsStringify(makeEntry('error', [err]))!
			expect(result).toContain('no stack here')
		})

		it('handles non-Error thrown values (string, plain object)', () => {
			const result1 = logsStringify(makeEntry('error', ['thrown string error']))
			expect(result1).toContain('thrown string error')

			const result2 = logsStringify(
				makeEntry('error', [{ code: 503, reason: 'too many requests' }]),
			)
			expect(result2).toContain('503')
			expect(result2).toContain('too many requests')
		})
	})

	describe('circular references', () => {
		it('does not throw on circular reference in args', () => {
			const obj: any = { name: 'circular' }
			obj.self = obj
			expect(() =>
				logsStringify(makeEntry('debug', ['context:', obj])),
			).not.toThrow()
		})

		it('outputs [Circular] placeholder for circular property', () => {
			const obj: any = { key: 'value' }
			obj.self = obj
			const result = logsStringify(makeEntry('debug', [obj]))!
			expect(result).toContain('[Circular]')
			expect(result).toContain('value')
		})

		it('preserves non-circular fields alongside circular refs', () => {
			const obj: any = { id: 42, name: 'test' }
			obj.loop = obj
			const result = logsStringify(makeEntry('info', [obj]))!
			expect(result).toContain('42')
			expect(result).toContain('test')
		})

		it('handles Error nested in circular object without losing message', () => {
			const container: any = { error: new Error('nested error') }
			container.self = container
			const result = logsStringify(makeEntry('error', [container]))!
			expect(result).toContain('nested error')
		})
	})

	describe('edge cases', () => {
		it('returns undefined for null input', () => {
			expect(logsStringify(null)).toBe(undefined)
		})

		it('returns undefined for undefined input', () => {
			expect(logsStringify(undefined)).toBe(undefined)
		})

		it('returns string input as-is (legacy fallback)', () => {
			expect(logsStringify('raw string')).toBe('raw string')
		})

		it('handles entry with zero args', () => {
			const result = logsStringify(makeEntry('info', []))
			expect(result).toBe('[2026-06-16 14:30:01] [info] ')
		})

		it('handles null arg inside args array', () => {
			const result = logsStringify(makeEntry('warn', [null]))
			expect(result).toContain('null')
		})

		it('handles undefined arg inside args array', () => {
			const result = logsStringify(makeEntry('warn', [undefined]))
			expect(result).toContain('undefined')
		})

		it('handles number and boolean args', () => {
			const result = logsStringify(makeEntry('debug', [42, true, false]))!
			expect(result).toContain('42')
			expect(result).toContain('true')
			expect(result).toContain('false')
		})

		it('records BigInt args instead of throwing', () => {
			const result = logsStringify(makeEntry('debug', [BigInt(42)]))!
			expect(result).toContain('42n')
		})

		it('handles deeply nested plain objects', () => {
			const deep = { a: { b: { c: { value: 'deep' } } } }
			const result = logsStringify(makeEntry('debug', [deep]))!
			expect(result).toContain('deep')
		})

		it('serializes array args', () => {
			const result = logsStringify(makeEntry('debug', [[1, 2, 3]]))!
			expect(result).toContain('1')
			expect(result).toContain('2')
			expect(result).toContain('3')
		})

		it('handles non-structured object input (legacy path) without throwing', () => {
			const legacy = ['2026-06-16 14:30:01', 'warn', ['some message']]
			expect(() => logsStringify(legacy)).not.toThrow()
		})

		it('does not throw when log entry getters are hostile', () => {
			const hostile = new Proxy(
				{ timestamp: '2026-06-16 14:30:01', level: 'warn', args: [] },
				{
					get(target, prop, receiver) {
						if (prop === 'args') {
							throw new Error('boom args')
						}
						return Reflect.get(target, prop, receiver)
					},
				},
			)
			expect(() => logsStringify(hostile)).not.toThrow()
		})
	})

	describe('realistic sync log scenarios', () => {
		it('formats a PushTask success log', () => {
			const result = logsStringify(
				makeEntry('info', [
					'[PushTask] notes/todo.md → /dav/notes/todo.md (2048 bytes)',
				]),
			)!
			expect(result).toBe(
				'[2026-06-16 14:30:01] [info] [PushTask] notes/todo.md → /dav/notes/todo.md (2048 bytes)',
			)
		})

		it('formats a sync decision log with object arg', () => {
			const stats = { push: 3, pull: 5, conflict: 1, noop: 12, total: 21 }
			const result = logsStringify(
				makeEntry('info', ['[Sync] Decision (policy=two-way):', stats]),
			)!
			expect(result).toContain('[Sync] Decision (policy=two-way):')
			expect(result).toContain('"push"')
			expect(result).toContain('3')
		})

		it('formats an upload failure with full error info', () => {
			const err = new Error('Upload failed: 403 Forbidden')
			const result = logsStringify(
				makeEntry('error', ['[PushTask] failed: notes/secret.md', err]),
			)!
			expect(result).toContain('[error]')
			expect(result).toContain('[PushTask] failed: notes/secret.md')
			expect(result).toContain('Upload failed: 403 Forbidden')
			// Should have stack
			expect(result).toMatch(/at .+:\d+/)
		})

		it('formats a 503 retry warning', () => {
			const result = logsStringify(
				makeEntry('warn', ['[Sync] 503 on notes/large.md, retry #1 in 60s']),
			)!
			expect(result).toContain('[warn]')
			expect(result).toContain('503')
			expect(result).toContain('retry #1')
		})

		it('formats a conflict resolve log', () => {
			const result = logsStringify(
				makeEntry('info', [
					'[ConflictResolve] notes/shared.md strategy=diff-match-patch',
				]),
			)!
			expect(result).toContain('ConflictResolve')
			expect(result).toContain('diff-match-patch')
		})
	})
})

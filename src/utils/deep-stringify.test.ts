import { describe, expect, it } from 'vitest'
import deepStringify from './deep-stringify'

describe('deepStringify', () => {
	describe('primitives', () => {
		it('handles null', () => {
			expect(deepStringify(null)).toBe('null')
		})

		it('handles boolean', () => {
			expect(deepStringify(true)).toBe('true')
			expect(deepStringify(false)).toBe('false')
		})

		it('handles string (with quotes and escaping)', () => {
			expect(deepStringify('hello')).toBe('"hello"')
			expect(deepStringify('with "quotes"')).toBe('"with \\"quotes\\""')
			expect(deepStringify('line\nnewline')).toBe('"line\\nnewline"')
		})

		it('handles finite numbers', () => {
			expect(deepStringify(42)).toBe('42')
			expect(deepStringify(3.14)).toBe('3.14')
			expect(deepStringify(0)).toBe('0')
			expect(deepStringify(-1)).toBe('-1')
		})

		it('converts NaN and Infinity to null', () => {
			expect(deepStringify(NaN)).toBe('null')
			expect(deepStringify(Infinity)).toBe('null')
			expect(deepStringify(-Infinity)).toBe('null')
		})

		it('returns undefined for function, symbol, undefined', () => {
			expect(deepStringify(undefined)).toBe(undefined)
			expect(deepStringify(() => {})).toBe(undefined)
			expect(deepStringify(Symbol('x'))).toBe(undefined)
		})
	})

	describe('Error objects', () => {
		it('serializes Error with name, message, and stack', () => {
			const err = new Error('something went wrong')
			const result = deepStringify(err)!
			const parsed = JSON.parse(result)
			expect(parsed.name).toBe('Error')
			expect(parsed.message).toBe('something went wrong')
			expect(parsed.stack).toContain('something went wrong')
		})

		it('preserves Error subclass name', () => {
			const err = new TypeError('bad type')
			const result = deepStringify(err)!
			const parsed = JSON.parse(result)
			expect(parsed.name).toBe('TypeError')
			expect(parsed.message).toBe('bad type')
		})

		it('handles Error with no stack (rare but possible)', () => {
			const err = new Error('no stack')
			delete (err as any).stack
			const result = deepStringify(err)!
			const parsed = JSON.parse(result)
			expect(parsed.message).toBe('no stack')
			expect(parsed.stack).toBeUndefined()
		})

		it('serializes Error nested inside an object', () => {
			const obj = { code: 404, cause: new TypeError('not found') }
			const result = deepStringify(obj)!
			const parsed = JSON.parse(result)
			expect(parsed.code).toBe(404)
			expect(parsed.cause.name).toBe('TypeError')
			expect(parsed.cause.message).toBe('not found')
			expect(parsed.cause.stack).toBeTruthy()
		})

		it('serializes Error nested inside an array', () => {
			const arr = [new Error('first'), new RangeError('out of range')]
			const result = deepStringify(arr)!
			const parsed = JSON.parse(result)
			expect(parsed[0].message).toBe('first')
			expect(parsed[1].name).toBe('RangeError')
		})
	})

	describe('circular references', () => {
		it('replaces direct circular reference with [Circular]', () => {
			const obj: any = { a: 1 }
			obj.self = obj
			const result = deepStringify(obj)!
			const parsed = JSON.parse(result)
			expect(parsed.a).toBe(1)
			expect(parsed.self).toBe('[Circular]')
		})

		it('replaces indirect circular reference with [Circular]', () => {
			const a: any = { name: 'a' }
			const b: any = { name: 'b', ref: a }
			a.ref = b
			const result = deepStringify(a)!
			const parsed = JSON.parse(result)
			expect(parsed.name).toBe('a')
			expect(parsed.ref.name).toBe('b')
			expect(parsed.ref.ref).toBe('[Circular]')
		})

		it('replaces circular reference inside an array', () => {
			const arr: any[] = [1, 2]
			arr.push(arr)
			const result = deepStringify(arr)!
			const parsed = JSON.parse(result)
			expect(parsed[0]).toBe(1)
			expect(parsed[2]).toBe('[Circular]')
		})

		it('allows the same object reference in multiple places (not truly circular)', () => {
			const shared = { x: 42 }
			const obj = { a: shared, b: shared }
			// deepStringify uses a visited set that removes after processing,
			// so the same object at sibling paths should be serialized in full.
			const result = deepStringify(obj)!
			const parsed = JSON.parse(result)
			expect(parsed.a.x).toBe(42)
			expect(parsed.b.x).toBe(42)
		})
	})

	describe('dates', () => {
		it('serializes valid Date to ISO string', () => {
			const d = new Date('2026-06-16T00:00:00.000Z')
			const result = deepStringify(d)!
			expect(JSON.parse(result)).toBe('2026-06-16T00:00:00.000Z')
		})

		it('serializes invalid Date to null', () => {
			const d = new Date('not-a-date')
			expect(deepStringify(d)).toBe('null')
		})
	})

	describe('objects and arrays', () => {
		it('omits undefined and function properties from objects', () => {
			const obj = { a: 1, b: undefined, c: () => {}, d: 'keep' }
			const result = deepStringify(obj)!
			const parsed = JSON.parse(result)
			expect(parsed.a).toBe(1)
			expect(parsed.d).toBe('keep')
			expect('b' in parsed).toBe(false)
			expect('c' in parsed).toBe(false)
		})

		it('replaces undefined/function array elements with null', () => {
			const arr = [1, undefined, () => {}, 'end']
			const result = deepStringify(arr)!
			const parsed = JSON.parse(result)
			expect(parsed).toEqual([1, null, null, 'end'])
		})

		it('handles deeply nested objects', () => {
			const deep = { a: { b: { c: { d: { value: 99 } } } } }
			const result = deepStringify(deep)!
			const parsed = JSON.parse(result)
			expect(parsed.a.b.c.d.value).toBe(99)
		})

		it('handles empty object and array', () => {
			expect(deepStringify({})).toBe('{}')
			expect(deepStringify([])).toBe('[]')
		})

		it('handles RegExp', () => {
			const result = deepStringify(/abc/gi)
			expect(result).toBeDefined()
		})

		it('serializes BigInt as a tagged string', () => {
			expect(deepStringify(BigInt(42))).toBe('"42n"')
			expect(deepStringify([BigInt(42)])).toBe('["42n"]')
		})
	})

	describe('getter errors', () => {
		it('captures getter error as error message string', () => {
			const obj = Object.defineProperty({}, 'bad', {
				get() {
					throw new Error('getter exploded')
				},
				enumerable: true,
			})
			const result = deepStringify(obj)!
			const parsed = JSON.parse(result)
			expect(parsed.bad).toContain('getter exploded')
		})

		it('survives getter error objects whose message getter also throws', () => {
			const obj = Object.defineProperty({}, 'bad', {
				get() {
					throw Object.defineProperty({}, 'message', {
						get() {
							throw new Error('second boom')
						},
					})
				},
				enumerable: true,
			})
			const result = deepStringify(obj)!
			const parsed = JSON.parse(result)
			expect(parsed.bad).toBe('Error accessing property')
		})

		it('captures proxy array access errors instead of throwing', () => {
			const arr = new Proxy([1, 2], {
				get(target, prop, receiver) {
					if (prop === '1') {
						throw new Error('prohibited index')
					}
					return Reflect.get(target, prop, receiver)
				},
			})
			const result = deepStringify(arr)!
			const parsed = JSON.parse(result)
			expect(parsed[0]).toBe(1)
			expect(parsed[1]).toContain('prohibited index')
		})
	})
})

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
	resolveByDiff3Merge,
	resolveByIntelligentMerge,
} from '~/sync/core/merge-utils'
import { jsonMergeEngine } from '~/sync/core/merge-engines/json-merge'
import { yjsTextMergeEngine } from '~/sync/core/merge-engines/yjs-text-merge'
import { simParams } from '../harness/sim-config'

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

const NEUTRAL_TOKENS = [
	'alpha',
	'beta',
	'gamma',
	'delta',
	'笔记',
	'摘要',
	'条目',
	'段落',
	'🌱',
	'📘',
	'🛠️',
	'👨‍👩‍👧‍👦',
	'🏳️‍🌈',
	'42',
	'3.14',
	'-100',
	'1e5',
	'# Heading',
	'- [x] done',
	'key: value',
	'a & b < c > d',
	'',
]

function hasLoneSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i += 1) {
		const code = value.charCodeAt(i)
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1)
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true
			i += 1
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true
		}
	}
	return false
}

function assertValidUtf16(value: string): void {
	expect(hasLoneSurrogate(value)).toBe(false)
	expect(utf8Decoder.decode(utf8Encoder.encode(value))).toBe(value)
}

const lineArb = fc
	.array(fc.constantFrom(...NEUTRAL_TOKENS), { minLength: 0, maxLength: 5 })
	.map((parts) => parts.join(' '))

const docLinesArb = fc.array(lineArb, { minLength: 0, maxLength: 14 })

const lineEditOpArb = fc.oneof(
	fc.record({
		kind: fc.constant('replace' as const),
		index: fc.nat(20),
		line: lineArb,
	}),
	fc.record({
		kind: fc.constant('insert' as const),
		index: fc.nat(20),
		line: lineArb,
	}),
	fc.record({
		kind: fc.constant('delete' as const),
		index: fc.nat(20),
	}),
)

type LineEditOp =
	| { kind: 'replace'; index: number; line: string }
	| { kind: 'insert'; index: number; line: string }
	| { kind: 'delete'; index: number }

function applyLineEdits(
	baseLines: readonly string[],
	ops: readonly LineEditOp[],
): string[] {
	const lines = [...baseLines]
	for (const op of ops) {
		if (op.kind === 'insert') {
			const pos = lines.length === 0 ? 0 : op.index % (lines.length + 1)
			lines.splice(pos, 0, op.line)
		} else if (lines.length > 0) {
			const pos = op.index % lines.length
			if (op.kind === 'replace') {
				lines[pos] = op.line
			} else {
				lines.splice(pos, 1)
			}
		}
	}
	return lines
}

describe('Merge engines property-based fuzzing', () => {
	it('satisfies algebraic laws and UTF-16 integrity for yjsTextMergeEngine', () => {
		fc.assert(
			fc.property(
				docLinesArb,
				fc.array(lineEditOpArb, { minLength: 0, maxLength: 5 }),
				fc.array(lineEditOpArb, { minLength: 0, maxLength: 5 }),
				fc.constantFrom('\n', '\r\n'),
				(baseLines, localOps, remoteOps, eol) => {
					const base = baseLines.join(eol)
					const local = applyLineEdits(baseLines, localOps).join(eol)
					const remote = applyLineEdits(baseLines, remoteOps).join(eol)

					// 1. One-sided local change must win verbatim
					const localOnly = yjsTextMergeEngine.merge({
						baseContentText: base,
						localContentText: local,
						remoteContentText: base,
						filePath: '笔记/sample🌱.md',
						hasBase: true,
					})
					expect(localOnly.success).toBe(true)
					expect(localOnly.mergedText).toBe(local)

					// 2. One-sided remote change must win verbatim
					const remoteOnly = yjsTextMergeEngine.merge({
						baseContentText: base,
						localContentText: base,
						remoteContentText: remote,
						filePath: '笔记/sample🌱.md',
						hasBase: true,
					})
					expect(remoteOnly.success).toBe(true)
					expect(remoteOnly.mergedText).toBe(remote)

					// 3. Equal concurrent edits must be idempotent
					const equalBoth = yjsTextMergeEngine.merge({
						baseContentText: base,
						localContentText: local,
						remoteContentText: local,
						filePath: '笔记/sample🌱.md',
						hasBase: true,
					})
					expect(equalBoth.success).toBe(true)
					expect(equalBoth.mergedText).toBe(local)

					// 4. General 3-way merge: valid UTF-16, no lone surrogates, no leaked conflict markers
					const merged = yjsTextMergeEngine.merge({
						baseContentText: base,
						localContentText: local,
						remoteContentText: remote,
						filePath: '笔记/sample🌱.md',
						hasBase: true,
					})
					expect(merged.success).toBe(true)
					expect(typeof merged.mergedText).toBe('string')
					assertValidUtf16(merged.mergedText!)
					if (
						!base.includes('<<<<<<<') &&
						!local.includes('<<<<<<<') &&
						!remote.includes('<<<<<<<')
					) {
						expect(merged.mergedText).not.toContain('<<<<<<<')
						expect(merged.mergedText).not.toContain('>>>>>>>')
					}
				},
			),
			simParams(60, 101),
		)
	})

	it('preserves disjoint edits without losing unrelated lines in NoConflictMerge and Diff3', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.stringMatching(/^[a-zA-Z0-9\u4e00-\u9fa5]{1,12}$/),
				fc.stringMatching(/^[a-zA-Z0-9\u4e00-\u9fa5]{1,12}$/),
				fc.constantFrom('🌱', '📘', '👨‍👩‍👧‍👦', '🛠️'),
				async (localTag, remoteTag, emoji) => {
					const base = [
						'# Header 标题',
						'line-top-stable',
						'middle-anchor-1',
						'middle-anchor-2',
						'middle-anchor-3',
						'line-bottom-stable',
					].join('\n')
					const local = [
						`# Header 标题 local-${localTag}-${emoji}`,
						'line-top-stable',
						'middle-anchor-1',
						'middle-anchor-2',
						'middle-anchor-3',
						'line-bottom-stable',
					].join('\n')
					const remote = [
						'# Header 标题',
						'line-top-stable',
						'middle-anchor-1',
						'middle-anchor-2',
						'middle-anchor-3',
						`line-bottom-stable remote-${remoteTag}-${emoji}`,
					].join('\n')

					const expected = [
						`# Header 标题 local-${localTag}-${emoji}`,
						'line-top-stable',
						'middle-anchor-1',
						'middle-anchor-2',
						'middle-anchor-3',
						`line-bottom-stable remote-${remoteTag}-${emoji}`,
					].join('\n')

					const intelligent = await resolveByIntelligentMerge({
						baseContentText: base,
						localContentText: local,
						remoteContentText: remote,
						filePath: 'notes/disjoint-🌱.md',
						hasBase: true,
					})
					expect(intelligent.success).toBe(true)
					expect(intelligent.mergedText).toBe(expected)
					assertValidUtf16(intelligent.mergedText!)

					const diff3 = resolveByDiff3Merge({
						baseContentText: base,
						localContentText: local,
						remoteContentText: remote,
						filePath: 'notes/disjoint-🌱.md',
						hasBase: true,
					})
					expect(diff3.success).toBe(true)
					expect(diff3.mergedText).toBe(expected)
					assertValidUtf16(diff3.mergedText!)
				},
			),
			simParams(40, 102),
		)
	})

	it('keeps numeric conflicts intact as complete local numbers across randomized values', () => {
		const numArb = fc.oneof(
			fc.integer({ min: -100_000, max: 100_000 }).map(String),
			fc
				.tuple(
					fc.integer({ min: 0, max: 9999 }),
					fc.integer({ min: 1, max: 999 }),
				)
				.map(([whole, frac]) => `${whole}.${frac}`),
		)

		fc.assert(
			fc.property(numArb, numArb, numArb, (baseNum, localNum, remoteNum) => {
				fc.pre(
					localNum !== baseNum &&
						remoteNum !== baseNum &&
						localNum !== remoteNum,
				)
				const base = `预算 budget: ${baseNum}\n备注 note: 原始 🌱`
				const local = `预算 budget: ${localNum}\n备注 note: 原始 🌱`
				const remote = `预算 budget: ${remoteNum}\n备注 note: 远端补充 📘`

				const merged = yjsTextMergeEngine.merge({
					baseContentText: base,
					localContentText: local,
					remoteContentText: remote,
					filePath: 'metrics/数字🌱.md',
					hasBase: true,
				})
				expect(merged.success).toBe(true)
				expect(merged.mergedText).toContain(`预算 budget: ${localNum}`)
				expect(merged.mergedText).toContain('备注 note: 远端补充 📘')
				assertValidUtf16(merged.mergedText!)
			}),
			simParams(50, 103),
		)

		// Regression invariants for shared surrogate halves & distinct same-line numbers
		for (const [base, local, remote] of [
			['😀', '😃', '😄'],
			['𠀀', '𠐀', '𠠀'],
			['𠀀', '𠀁', '𠀂'],
		] as const) {
			const merged = yjsTextMergeEngine.merge({
				baseContentText: `Status 状态 🧭: ${base}\n`,
				localContentText: `Status 状态 🧭: ${local}\n`,
				remoteContentText: `Status 状态 🧭: ${remote}\n`,
				filePath: 'unicode.md',
				hasBase: true,
			})
			expect(merged.success).toBe(true)
			assertValidUtf16(merged.mergedText!)
			expect([
				`Status 状态 🧭: ${local}${remote}\n`,
				`Status 状态 🧭: ${remote}${local}\n`,
			]).toContain(merged.mergedText)
		}

		const sameLineNumbers = yjsTextMergeEngine.merge({
			baseContentText: 'Count 数量 🌱: 100; limit: 100\n',
			localContentText: 'Count 数量 🌱: 150; limit: 100\n',
			remoteContentText: 'Count 数量 🌱: 120; limit: 200\n',
			filePath: 'numbers.md',
			hasBase: true,
		})
		expect(sameLineNumbers.mergedText).toBe('Count 数量 🌱: 150; limit: 200\n')
	})

	it('maintains valid JSON, disjoint key preservation, and zero prototype pollution in jsonMergeEngine', () => {
		const jsonKeyArb = fc.constantFrom(
			'title',
			'count',
			'enabled',
			'标题',
			'标签🌱',
			'nested',
			'__proto__',
			'constructor',
			'toString',
		)
		const jsonLeafArb = fc.oneof(
			fc.string({ maxLength: 16 }),
			fc.integer({ min: -1000, max: 1000 }),
			fc.boolean(),
			fc.constant(null),
			fc.constant('中文内容 🌱'),
		)
		const jsonObjArb = fc.dictionary(jsonKeyArb, jsonLeafArb, {
			minKeys: 0,
			maxKeys: 6,
		})

		fc.assert(
			fc.property(
				jsonObjArb,
				jsonObjArb,
				jsonObjArb,
				(baseObj, localObj, remoteObj) => {
					const base = JSON.stringify(baseObj, null, 2)
					const local = JSON.stringify(localObj, null, 2)
					const remote = JSON.stringify(remoteObj, null, 2)

					const res = jsonMergeEngine.merge({
						baseContentText: base,
						localContentText: local,
						remoteContentText: remote,
						filePath: 'config/设置🌱.json',
						hasBase: true,
					})
					expect(res.success).toBe(true)
					expect(typeof res.mergedText).toBe('string')
					// Output must always be valid JSON
					const parsed = JSON.parse(res.mergedText!) as Record<string, unknown>
					expect(typeof parsed).toBe('object')
					// Prototype pollution guard
					expect(({} as Record<string, unknown>).polluted).toBeUndefined()
					expect(Object.prototype).not.toHaveProperty('polluted')

					// Disjoint one-sided key edit must be preserved
					const localOnly = jsonMergeEngine.merge({
						baseContentText: base,
						localContentText: local,
						remoteContentText: base,
						filePath: 'config/设置🌱.json',
						hasBase: true,
					})
					expect(JSON.parse(localOnly.mergedText!)).toEqual(JSON.parse(local))

					const remoteOnly = jsonMergeEngine.merge({
						baseContentText: base,
						localContentText: base,
						remoteContentText: remote,
						filePath: 'config/设置🌱.json',
						hasBase: true,
					})
					expect(JSON.parse(remoteOnly.mergedText!)).toEqual(JSON.parse(remote))
				},
			),
			simParams(60, 104),
		)
	})
})

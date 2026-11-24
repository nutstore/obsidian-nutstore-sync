import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { diffComm, mergeDiff3 } from './line-diff3'

function dpLcsLength(a: readonly string[], b: readonly string[]): number {
	const n = a.length
	const m = b.length
	const prev = new Int32Array(m + 1)
	const curr = new Int32Array(m + 1)
	for (let i = 1; i <= n; i += 1) {
		for (let j = 1; j <= m; j += 1) {
			curr[j] =
				a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1])
		}
		prev.set(curr)
	}
	return prev[m]
}

describe('line-diff3 (Patience + linear-space Myers)', () => {
	it('handles empty inputs, identical documents, CRLF, and single-sided changes', () => {
		expect(diffComm([], [])).toEqual([])
		expect(diffComm(['标题 🌱', '正文'], ['标题 🌱', '正文'])).toEqual([
			{ common: ['标题 🌱', '正文'] },
		])

		expect(mergeDiff3('', '', '', { stringSeparator: '\n' })).toEqual({
			conflict: false,
			result: [''],
		})

		const crlfBase = '第一行 🌱\r\n共享段落\r\n末尾'
		const crlfLocal = '第一行 🌱（本地）\r\n共享段落\r\n末尾'
		const crlfRemote = '第一行 🌱\r\n共享段落\r\n末尾（远端 📘）'
		const merged = mergeDiff3(crlfLocal, crlfBase, crlfRemote, {
			stringSeparator: '\n',
			label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' },
		})
		expect(merged.conflict).toBe(false)
		expect(merged.result.join('\n')).toBe(
			'第一行 🌱（本地）\r\n共享段落\r\n末尾（远端 📘）',
		)
	})

	it('resolves false conflicts cleanly when excludeFalseConflicts is true and preserves conflicts when false', () => {
		const base = '标题\n旧段落 📝\n结尾'
		const both = '标题\n共同修改后的段落 ✨\n结尾'

		const autoResolved = mergeDiff3(both, base, both, {
			excludeFalseConflicts: true,
			stringSeparator: '\n',
			label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' },
		})
		expect(autoResolved.conflict).toBe(false)
		expect(autoResolved.result.join('\n')).toBe(both)

		const explicitConflict = mergeDiff3(both, base, both, {
			excludeFalseConflicts: false,
			stringSeparator: '\n',
			label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' },
		})
		expect(explicitConflict.conflict).toBe(true)
		expect(explicitConflict.result.join('\n')).toContain('<<<<<<< LOCAL')

		// Identical deletion on both sides
		const delResolved = mergeDiff3('标题\n结尾', base, '标题\n结尾', {
			excludeFalseConflicts: true,
			stringSeparator: '\n',
		})
		expect(delResolved.conflict).toBe(false)
		expect(delResolved.result.join('\n')).toBe('标题\n结尾')
	})

	it('keeps Markdown blank-line rewrites in one clean conflict block via Patience anchors', () => {
		const base = ['# 章节概览 🌱', '原段说明', '# 尾部总结 📘'].join('\n')
		const local = [
			'# 章节概览 🌱',
			'本地改写甲',
			'',
			'本地改写乙',
			'# 尾部总结 📘',
		].join('\n')
		const remote = [
			'# 章节概览 🌱',
			'远端重排一',
			'',
			'远端重排二',
			'# 尾部总结 📘',
		].join('\n')

		const merged = mergeDiff3(local, base, remote, {
			excludeFalseConflicts: true,
			stringSeparator: '\n',
			label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' },
		})
		expect(merged.conflict).toBe(true)
		const text = merged.result.join('\n')
		expect(text.match(/<<<<<<< LOCAL/g)).toHaveLength(1)
		expect(text).toContain('本地改写甲\n\n本地改写乙')
		expect(text).toContain('远端重排一\n\n远端重排二')

		const regions = diffComm(
			['# 标题一 🌱', '唯一小节 🌿', '', '左段一', '# 标题二 📘'],
			['# 标题一 🌱', '', '唯一小节 🌿', '右段一', '# 标题二 📘'],
		)
		expect(regions.filter((r) => r.common).map((r) => r.common)).toEqual([
			['# 标题一 🌱'],
			['唯一小节 🌿'],
			['# 标题二 📘'],
		])

		// Custom anchor filter ignores moved metadata/blank wrappers so unique prose wins
		const scopedRegions = diffComm(
			['{"t":"blank"}', '{"t":"prose","text":"唯一正文 📘"}', '左补充'],
			['{"t":"prose","text":"唯一正文 📘"}', '{"t":"blank"}', '右补充'],
			{ canAnchor: (line) => line.includes('"prose"') },
		)
		expect(scopedRegions.filter((r) => r.common).map((r) => r.common)).toEqual([
			['{"t":"prose","text":"唯一正文 📘"}'],
		])
	})

	it('merges 70,000-line documents without overflowing the call stack', () => {
		const lineCount = 70_000
		const base = Array.from({ length: lineCount }, (_, i) =>
			i % 5 === 0 ? '' : `Line ${i}: 中性笔记条目 🌱`,
		)
		const local = [...base]
		local[20] = 'Line 20: 本地更新 🌿'
		const remote = [...base]
		remote[lineCount - 20] = 'Line end: 远端更新 📘'

		const merged = mergeDiff3(local, base, remote, {
			excludeFalseConflicts: true,
			label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' },
		})
		expect(merged.conflict).toBe(false)
		expect(merged.result).toHaveLength(lineCount)
		expect(merged.result[20]).toBe('Line 20: 本地更新 🌿')
		expect(merged.result[lineCount - 20]).toBe('Line end: 远端更新 📘')
	})

	it('handles 12,001-line deeply nested Patience partitions without overflowing the stack', () => {
		const depth = 6_000
		const base: string[] = [`节点 ${depth} 🌱`]
		for (let i = depth - 1; i >= 0; i -= 1) {
			base.push(
				`节点 ${i} 📘`,
				`节点 ${i + 1} ${i + 1 === depth ? '🌱' : '📘'}`,
			)
		}
		const local: string[] = []
		for (let i = depth; i >= 0; i -= 1) {
			local.push(`节点 ${i} ${i === depth ? '🌱' : '📘'}`)
		}
		local.push('本地追加末尾 🌿')
		const remote = [...base]

		const merged = mergeDiff3(local, base, remote, {
			excludeFalseConflicts: true,
			label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' },
		})
		expect(merged.conflict).toBe(false)
		expect(merged.result).toEqual(local)
	})

	it('preserves repeated matches across a 4,100-line insertion without spurious conflict markers', () => {
		const repeated = Array.from({ length: 140 }, (_, i) =>
			i % 2 === 0 ? '- [ ] 重复清单条目 🌱' : '- [ ] 例行检查条目 📘',
		)
		const base = [...repeated, '页脚 footer: v1']
		const inserted = Array.from(
			{ length: 4_100 },
			(_, i) => `新增记录行 ${i} 🌿`,
		)
		const local = [...inserted, ...repeated, '页脚 footer: v2-local']
		const remote = [...repeated, '页脚 footer: v1']
		remote[70] = '- [x] 远端完成条目 ✅'

		const merged = mergeDiff3(local, base, remote, {
			excludeFalseConflicts: true,
			label: { a: 'LOCAL', o: 'BASE', b: 'REMOTE' },
		})
		expect(merged.conflict).toBe(false)
		expect(merged.result).toHaveLength(local.length)
		expect(merged.result[4_100 + 70]).toBe('- [x] 远端完成条目 ✅')
		expect(merged.result[merged.result.length - 1]).toBe(
			'页脚 footer: v2-local',
		)
	})

	it('losslessly reconstructs both inputs in diffComm and achieves exact LCS on duplicate-heavy arrays', () => {
		const tokenArb = fc.constantFrom('a', 'b', 'c', '', '笔记🌱', '摘要📘')
		fc.assert(
			fc.property(
				fc.array(tokenArb, { minLength: 0, maxLength: 20 }),
				fc.array(tokenArb, { minLength: 0, maxLength: 20 }),
				(left, right) => {
					const regions = diffComm(left, right)
					const reconstructedLeft: string[] = []
					const reconstructedRight: string[] = []
					let commonCount = 0
					for (const region of regions) {
						if (region.common) {
							reconstructedLeft.push(...region.common)
							reconstructedRight.push(...region.common)
							commonCount += region.common.length
						} else {
							reconstructedLeft.push(...region.buffer1)
							reconstructedRight.push(...region.buffer2)
						}
					}
					expect(reconstructedLeft).toEqual(left)
					expect(reconstructedRight).toEqual(right)
					// When there are no unique anchors (all tokens repeated), Myers must match exact DP LCS.
					if (left.length <= 12 && right.length <= 12) {
						const uniqueLeft = new Set(
							left.filter((x) => left.indexOf(x) === left.lastIndexOf(x)),
						)
						const uniqueRight = new Set(
							right.filter((x) => right.indexOf(x) === right.lastIndexOf(x)),
						)
						const hasSharedUnique = [...uniqueLeft].some((x) =>
							uniqueRight.has(x),
						)
						if (!hasSharedUnique) {
							expect(commonCount).toBe(dpLcsLength(left, right))
						}
					}
				},
			),
			{ numRuns: 200, seed: 2026 },
		)
	})

	it('satisfies 3-way merge algebraic laws across randomized edits', () => {
		const lineArb = fc.constantFrom(
			'alpha',
			'beta',
			'段落 🌱',
			'记录 📘',
			'',
			'footer',
		)
		fc.assert(
			fc.property(
				fc.array(lineArb, { minLength: 0, maxLength: 16 }),
				fc.array(lineArb, { minLength: 0, maxLength: 16 }),
				fc.array(lineArb, { minLength: 0, maxLength: 16 }),
				(base, local, remote) => {
					const localOnly = mergeDiff3(local, base, base, {
						excludeFalseConflicts: true,
					})
					expect(localOnly.conflict).toBe(false)
					expect(localOnly.result).toEqual(local)

					const remoteOnly = mergeDiff3(base, base, remote, {
						excludeFalseConflicts: true,
					})
					expect(remoteOnly.conflict).toBe(false)
					expect(remoteOnly.result).toEqual(remote)

					const equalBoth = mergeDiff3(local, base, local, {
						excludeFalseConflicts: true,
					})
					expect(equalBoth.conflict).toBe(false)
					expect(equalBoth.result).toEqual(local)
				},
			),
			{ numRuns: 150, seed: 2027 },
		)
	})
})

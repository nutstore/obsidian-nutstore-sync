import { describe, expect, it } from 'vitest'
import {
	LOG_RETENTION_BYTE_LIMIT,
	LOG_RETENTION_LINE_LIMIT,
	LogRetention,
} from './log-retention'

/** One line of a realistic, bilingual log history. */
function line(index: number) {
	return `[2026-11-09 15:30:${String(index % 60).padStart(2, '0')}] [debug] 同步决策 示例-${index}.md ✅`
}

/** Deterministic pseudo-random text that compresses badly, like ids or file hashes. */
function noiseLine(seed: number) {
	let state = seed + 1
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
	let text = ''
	for (let index = 0; index < 100; index++) {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
		text += alphabet[state % alphabet.length]
	}
	return text
}

describe('LogRetention', () => {
	it('exposes the documented retention budgets', () => {
		expect(LOG_RETENTION_LINE_LIMIT).toBe(100_000)
		expect(LOG_RETENTION_BYTE_LIMIT).toBe(16 * 1024 * 1024)
	})

	it('round-trips every line in order, including across chunk seams', () => {
		const retention = new LogRetention()
		const lines = Array.from({ length: 1_200 }, (_, index) => line(index))

		for (const entry of lines) retention.append(entry)

		expect(retention.collect()).toBe(lines.join('\n'))
		expect(retention.collect().split('\n')).toHaveLength(lines.length)
		expect(retention.stats.lines).toBe(lines.length)
		expect(retention.stats.sealedChunks).toBeGreaterThan(0)
	})

	it('keeps unicode, emoji and over-long lines byte-exact', () => {
		const retention = new LogRetention()
		const entries = [
			'文件：議事録_2026.md — naïve café 🌏',
			`长行 ${'汉'.repeat(10_000)}🧭`,
			'混合 Mixed 文本 🧩',
		]

		for (const entry of entries) retention.append(entry)

		expect(retention.collect()).toBe(entries.join('\n'))
	})

	it('compresses retained text far below its raw character size', () => {
		const retention = new LogRetention()
		const lines = Array.from({ length: 4_096 }, (_, index) => line(index))

		for (const entry of lines) retention.append(entry)

		const rawBytes = lines.join('\n').length * 2 // UTF-16 upper bound
		expect(retention.stats.compressedBytes).toBeLessThan(rawBytes / 4)
		expect(retention.collect()).toContain(lines[lines.length - 1])
	})

	it('evicts oldest whole chunks once the line budget is exceeded', () => {
		const retention = new LogRetention({
			lineLimit: 100,
			byteLimit: LOG_RETENTION_BYTE_LIMIT,
		})
		const lines = Array.from({ length: 1_000 }, (_, index) => line(index))

		for (const entry of lines) retention.append(entry)

		// Eviction is chunk-granular, so the bound includes the newest chunk and
		// the pending tail (at most 2 * CHUNK_LINE_LIMIT - 1 entries).
		expect(retention.stats.lines).toBeLessThanOrEqual(100 + 512)
		expect(retention.stats.lines).toBeLessThan(1_000)
		const kept = retention.collect().split('\n')
		expect(kept).toHaveLength(retention.stats.lines)
		expect(kept[kept.length - 1]).toBe(lines[lines.length - 1])
		expect(kept).not.toContain(lines[0])
		// Nothing is truncated: every kept line is one of the appended lines.
		expect(kept.every((entry) => lines.includes(entry))).toBe(true)
	})

	it('evicts oldest chunks once the compressed-byte budget is exceeded', () => {
		const retention = new LogRetention({
			lineLimit: 1_000_000,
			byteLimit: 64 * 1024,
		})

		for (let index = 0; index < 3_000; index++)
			retention.append(noiseLine(index))

		expect(retention.stats.compressedBytes).toBeLessThanOrEqual(64 * 1024)
		expect(retention.stats.lines).toBeLessThan(3_000)
		expect(retention.collect()).toContain(noiseLine(2_999))
	})

	it('always keeps the newest chunk, even when it alone exceeds the budget', () => {
		const retention = new LogRetention({ lineLimit: 1, byteLimit: 1 })

		for (let index = 0; index < 1_024; index++) retention.append(line(index))

		expect(retention.stats.sealedChunks).toBe(1)
		const kept = retention.collect().split('\n')
		expect(kept[kept.length - 1]).toBe(line(1_023))
	})

	it('clear() empties the retention and later appends start fresh', () => {
		const retention = new LogRetention()
		retention.append(line(1))
		retention.append(line(2))

		retention.clear()

		expect(retention.collect()).toBe('')
		expect(retention.stats).toEqual({
			lines: 0,
			sealedChunks: 0,
			pendingLines: 0,
			compressedBytes: 0,
		})

		retention.append(line(3))
		expect(retention.collect()).toBe(line(3))
	})
})

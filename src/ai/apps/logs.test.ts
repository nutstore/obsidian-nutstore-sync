// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { App } from 'obsidian'
import { AppLifecycleQueue } from './lifecycle'
import {
	APP_LOG_HIGH_WATERMARK_BYTES,
	APP_LOG_LOW_WATERMARK_BYTES,
	APP_LOG_MAX_FIELD_BYTES,
	AppLogStore,
	compactAppLogLines,
	truncateFieldByBytes,
	utf8ByteLength,
	type AppLogEvent,
} from './logs'
import { APP_LOG_FILE, APP_MANIFEST_FILE, appDirectoryPath } from './paths'

vi.mock('~/utils/mkdirs-vault', () => ({ mkdirsVault: async () => {} }))

const encoder = new TextEncoder()

function hasLoneSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1)
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true
			i++
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true
		}
	}
	return false
}

function makeLine(
	overrides: Partial<AppLogEvent> & { index?: number } = {},
): string {
	return JSON.stringify({
		schemaVersion: 1,
		timestamp: 1_700_000_000_000 + (overrides.index ?? 0),
		appId: 'org.example.logs',
		level: overrides.level ?? 'info',
		source: overrides.source ?? 'console',
		message: overrides.message ?? '中性日志 Neutral log 🌿',
		...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
	})
}

function createStoreFixture(
	limits?: Partial<{
		highWatermarkBytes: number
		lowWatermarkBytes: number
		maxFieldBytes: number
	}>,
) {
	const appId = 'org.example.logs'
	const manifestPath = `${appDirectoryPath(appId)}/${APP_MANIFEST_FILE}`
	const logPath = `${appDirectoryPath(appId)}/${APP_LOG_FILE}`
	const disk = new Map<string, string>([[manifestPath, '{}']])

	const adapter = {
		exists: vi.fn(async (path: string) => disk.has(path)),
		stat: vi.fn(async (path: string) => {
			const value = disk.get(path)
			if (value === undefined) return null
			return {
				type: 'file' as const,
				ctime: 0,
				mtime: 0,
				size: encoder.encode(value).byteLength,
			}
		}),
		read: vi.fn(async (path: string) => {
			const value = disk.get(path)
			if (value === undefined) throw new Error(`Missing: ${path}`)
			return value
		}),
		write: vi.fn(async (path: string, content: string) => {
			disk.set(path, content)
		}),
		append: vi.fn(async (path: string, content: string) => {
			disk.set(path, (disk.get(path) ?? '') + content)
		}),
		process: vi.fn(async (path: string, fn: (content: string) => string) => {
			const next = fn(disk.get(path) ?? '')
			disk.set(path, next)
			return next
		}),
	}
	const app = { vault: { adapter } } as unknown as Pick<App, 'vault'>
	const store = new AppLogStore(app, new AppLifecycleQueue(), limits)
	return { appId, logPath, disk, adapter, store }
}

describe('AppLogStore retention, compaction and UTF-8 field guards', () => {
	it('exposes the agreed 2 MiB / 512 KiB / 64 KiB defaults and rejects invalid limits', () => {
		expect(APP_LOG_HIGH_WATERMARK_BYTES).toBe(2 * 1024 * 1024)
		expect(APP_LOG_LOW_WATERMARK_BYTES).toBe(512 * 1024)
		expect(APP_LOG_MAX_FIELD_BYTES).toBe(64 * 1024)

		const lifecycle = new AppLifecycleQueue()
		const app = { vault: { adapter: {} } } as unknown as Pick<App, 'vault'>
		expect(
			() =>
				new AppLogStore(app, lifecycle, {
					highWatermarkBytes: 1024,
					lowWatermarkBytes: 2048,
				}),
		).toThrow(RangeError)
		expect(
			() => new AppLogStore(app, lifecycle, { highWatermarkBytes: 0 }),
		).toThrow(RangeError)
		expect(
			() => new AppLogStore(app, lifecycle, { maxFieldBytes: -1 }),
		).toThrow(RangeError)
	})

	it('matches TextEncoder byte length across ASCII, CJK, Emoji and lone surrogates', () => {
		const samples = [
			'',
			'plain ascii 123',
			'中文日志记录',
			'🌿🧭📘🚀',
			'混合 Mixed 中文 🌿 éàü',
			`前\uD83C后`, // lone high surrogate
			`前\uDF3F后`, // lone low surrogate
		]
		for (const sample of samples) {
			expect(utf8ByteLength(sample)).toBe(encoder.encode(sample).byteLength)
		}
	})

	it('truncates oversized CJK and Emoji fields by UTF-8 bytes without splitting surrogate pairs', () => {
		const head = '开头 Head 🌿'
		const tail = '结尾 Tail 🧭'
		const huge = `${head}${'🌿中文A'.repeat(200)}${tail}`

		for (const maxBytes of [96, 127, 128, 129, 256]) {
			const truncated = truncateFieldByBytes(huge, maxBytes)
			expect(encoder.encode(truncated).byteLength).toBeLessThanOrEqual(maxBytes)
			expect(hasLoneSurrogate(truncated)).toBe(false)
			expect(truncated.startsWith('开头')).toBe(true)
			expect(truncated.endsWith('🧭')).toBe(true)
			expect(truncated).toMatch(/\[truncated \d+ chars\]/)
		}

		// Strings already within the byte budget are returned verbatim.
		const exact = '精确 Exact 中文 🌿'
		expect(truncateFieldByBytes(exact, utf8ByteLength(exact))).toBe(exact)
	})

	it('uses incremental append below high watermark and compacts once on overflow with hysteresis', async () => {
		const high = 1_600
		const low = 600
		const { appId, logPath, disk, adapter, store } = createStoreFixture({
			highWatermarkBytes: high,
			lowWatermarkBytes: low,
		})

		// First flush creates the file with write; subsequent small flushes use append (never process).
		store.append(appId, {
			level: 'info',
			source: 'console',
			sessionId: 's1',
			message: '首条记录 First entry 🌿',
		})
		await store.flush(appId)
		expect(adapter.write).toHaveBeenCalledTimes(1)
		expect(adapter.append).toHaveBeenCalledTimes(0)
		expect(adapter.process).toHaveBeenCalledTimes(0)

		store.append(appId, {
			level: 'error',
			source: 'uncaught',
			sessionId: 's1',
			message: '关键错误 Important failure 🧭',
		})
		await store.flush(appId)
		expect(adapter.append).toHaveBeenCalledTimes(1)
		expect(adapter.process).toHaveBeenCalledTimes(0)

		// Push total size past high watermark (1,600 B) to trigger a single compaction down to <= 600 B.
		for (let i = 0; i < 8; i++) {
			store.append(appId, {
				level: 'debug',
				source: 'console',
				sessionId: 's1',
				message: `冗余调试 Verbose #${i} ${'中文内容 '.repeat(12)}🌿`,
			})
		}
		await store.flush(appId)
		expect(adapter.process).toHaveBeenCalledTimes(1)

		const afterCompaction = disk.get(logPath) ?? ''
		expect(encoder.encode(afterCompaction).byteLength).toBeLessThanOrEqual(low)
		const parsed = afterCompaction
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as AppLogEvent)
		// Error entry survives compaction over verbose debug entries.
		expect(
			parsed.some((e) => e.message === '关键错误 Important failure 🧭'),
		).toBe(true)

		// Hysteresis: a small append after compaction uses append again, not process.
		store.append(appId, {
			level: 'info',
			source: 'console',
			sessionId: 's2',
			message: '新会话记录 New session entry 🌱',
		})
		await store.flush(appId)
		expect(adapter.process).toHaveBeenCalledTimes(1)
		expect(adapter.append).toHaveBeenCalledTimes(2)
	})

	it('prioritizes errors and latest session over older verbose logs while keeping chronological order', () => {
		const existing = [
			'not-valid-json-line',
			makeLine({
				index: 1,
				sessionId: 's1',
				level: 'debug',
				message: `旧调试 Old debug ${'甲'.repeat(80)} 🌿`,
			}),
			makeLine({
				index: 2,
				sessionId: 's1',
				level: 'error',
				message: '旧错误 Old error 🧭',
			}),
			makeLine({
				index: 3,
				sessionId: 's1',
				level: 'info',
				message: `旧信息 Old info ${'乙'.repeat(80)} 🌿`,
			}),
			makeLine({
				index: 4,
				sessionId: 's1',
				level: 'warn',
				message: '旧警告 Old warn 🌿',
			}),
			makeLine({
				index: 5,
				sessionId: 's2',
				level: 'log',
				message: '当前日志 Current log 🌿',
			}),
		]
		const incoming = [
			makeLine({
				index: 6,
				sessionId: 's2',
				level: 'error',
				message: '当前错误 Current error 🧭',
			}),
		]

		// Budget enough to keep s1 error + s1 warn + full s2, but not malformed + s1 debug/info.
		const target =
			utf8ByteLength(existing[2]) +
			1 +
			utf8ByteLength(existing[4]) +
			1 +
			utf8ByteLength(existing[5]) +
			1 +
			utf8ByteLength(incoming[0]) +
			1

		const compacted = compactAppLogLines(existing, incoming, {
			highWatermarkBytes: target + 50,
			lowWatermarkBytes: target,
			maxFieldBytes: APP_LOG_MAX_FIELD_BYTES,
		})

		expect(encoder.encode(compacted).byteLength).toBeLessThanOrEqual(target)
		const kept = compacted
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as AppLogEvent & { timestamp: number })
		expect(kept.map((e) => e.message)).toEqual([
			'旧错误 Old error 🧭',
			'旧警告 Old warn 🌿',
			'当前日志 Current log 🌿',
			'当前错误 Current error 🧭',
		])
		// Chronological order preserved.
		for (let i = 1; i < kept.length; i++) {
			expect(kept[i].timestamp).toBeGreaterThan(kept[i - 1].timestamp)
		}

		// Under tighter pressure, older warn/error are dropped before latest-session logs.
		const latestOnlyBudget =
			utf8ByteLength(existing[5]) + 1 + utf8ByteLength(incoming[0]) + 1
		const tighter = compactAppLogLines(existing, incoming, {
			highWatermarkBytes: latestOnlyBudget + 50,
			lowWatermarkBytes: latestOnlyBudget,
			maxFieldBytes: APP_LOG_MAX_FIELD_BYTES,
		})
		const tighterKept = tighter
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as AppLogEvent)
		expect(tighterKept.map((e) => e.message)).toEqual([
			'当前日志 Current log 🌿',
			'当前错误 Current error 🧭',
		])
	})

	it('always preserves the newest entry even when a single entry exceeds lowWatermarkBytes', () => {
		const existing = [
			makeLine({
				index: 1,
				sessionId: 's1',
				level: 'error',
				message: '旧错误 Old error 🌿',
			}),
		]
		const incoming = [
			makeLine({
				index: 2,
				sessionId: 's2',
				level: 'error',
				message: `最新超长错误 Latest error ${'丙'.repeat(120)} 🧭`,
			}),
		]
		const compacted = compactAppLogLines(existing, incoming, {
			highWatermarkBytes: 200,
			lowWatermarkBytes: 100,
			maxFieldBytes: APP_LOG_MAX_FIELD_BYTES,
		})
		const lines = compacted.trim().split('\n')
		expect(lines).toHaveLength(1)
		expect(JSON.parse(lines[0]).message).toContain('最新超长错误 Latest error')
	})

	it('also bounds oversized error causes without losing root diagnostic framing', async () => {
		const { appId, logPath, disk, store } = createStoreFixture({
			maxFieldBytes: 160,
		})
		store.append(appId, {
			level: 'error',
			source: 'uncaught',
			message: '外层错误 Outer error 🌿',
			causes: [
				{
					name: 'CauseError',
					message: `根因开始 Cause start 🌿 ${'细节 Detail 📘 '.repeat(50)} 根因结束 Cause end 🧭`,
					stack: `StackStart 🌿\n${'at fn (a.js:1:1)\n'.repeat(50)}StackEnd 🧭`,
				},
			],
		})
		await store.flush(appId)
		const stored = JSON.parse((disk.get(logPath) ?? '').trim()) as AppLogEvent
		const cause = stored.causes?.[0]
		expect(cause).toBeDefined()
		if (!cause || !cause.stack) return
		expect(encoder.encode(cause.message).byteLength).toBeLessThanOrEqual(160)
		expect(cause.message.startsWith('根因开始')).toBe(true)
		expect(cause.message.endsWith('🧭')).toBe(true)
		expect(hasLoneSurrogate(cause.message)).toBe(false)
		expect(encoder.encode(cause.stack).byteLength).toBeLessThanOrEqual(160)
		expect(cause.stack.startsWith('StackStart')).toBe(true)
		expect(cause.stack.endsWith('🧭')).toBe(true)
	})
})

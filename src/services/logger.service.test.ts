import { LogLevels } from 'consola'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import logger from '~/utils/logger'
import { LOG_RETENTION_LINE_LIMIT } from './log-retention'
import LoggerService from './logger.service'

type ServiceOptions = ConstructorParameters<typeof LoggerService>[0]

/** `[YYYY-MM-DD HH:mm:ss] [level]` — the shape every retained line starts with. */
const LINE_PATTERN =
	/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[(debug|info|warn|error)\] /

describe('LoggerService retention', () => {
	let service: LoggerService

	beforeEach(() => {
		// `test/vitest.setup.ts` pins the shared logger to silent.
		logger.level = LogLevels.verbose
		// The service ignores its plugin argument; only the log sink is under test.
		service = new LoggerService(undefined as unknown as ServiceOptions)
		service.onload()
	})

	afterEach(() => {
		service.onunload()
		logger.level = LogLevels.silent
		vi.useRealTimers()
	})

	it('starts empty and exposes the retention budget', () => {
		expect(service.collectLogs()).toBe('')
		expect(service.stats).toEqual({
			lines: 0,
			sealedChunks: 0,
			pendingLines: 0,
			compressedBytes: 0,
		})
	})

	it('formats entries at write time with local timestamp, level and args', () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date(2026, 1, 10, 0, 30, 4))

		logger.info('信息就绪 ✅', { 数量: 3 })
		logger.warn('警告 重试')

		const lines = service.collectLogs().split('\n')
		expect(lines).toHaveLength(2)
		expect(lines[0]).toBe('[2026-02-10 00:30:04] [info] 信息就绪 ✅ {"数量":3}')
		expect(lines[1]).toMatch(LINE_PATTERN)
		expect(lines[1]).toContain('[warn]')
		expect(lines[1]).toContain('警告 重试')
	})

	it('snapshots the logged state: a later mutation cannot change saved text', () => {
		const payload = { reason: '本地变更', count: 1 }

		logger.info('决策', payload)
		const saved = service.collectLogs()

		payload.reason = '远端变更'
		payload.count = 2

		expect(service.collectLogs()).toBe(saved)
		expect(saved).toContain('本地变更')
		expect(saved).not.toContain('远端变更')
	})

	it('keeps entry order across chunk seams', () => {
		const total = 1_200
		for (let index = 0; index < total; index++) logger.info(`条目 ${index}`)

		const lines = service.collectLogs().split('\n')
		expect(lines).toHaveLength(total)
		expect(lines[0]).toContain('条目 0')
		expect(lines[total - 1]).toContain(`条目 ${total - 1}`)
		expect(service.stats.lines).toBe(total)
		expect(service.stats.sealedChunks).toBeGreaterThan(0)
	})

	it('retains a six-figure line history within the compressed-byte budget', () => {
		const total = LOG_RETENTION_LINE_LIMIT
		for (let index = 0; index < total; index++) logger.info(`批量 ${index}`)

		const lines = service.collectLogs().split('\n')
		expect(lines).toHaveLength(total)
		expect(lines[0]).toContain('批量 0')
		expect(lines[total - 1]).toContain(`批量 ${total - 1}`)
		expect(service.stats.lines).toBe(total)
		// The reason a six-figure history is affordable: it is compressed.
		expect(service.stats.compressedBytes).toBeLessThan(total * 4)
		expect(service.stats.compressedBytes).toBeLessThan(16 * 1024 * 1024)
	})

	it('evicts the oldest lines once the line budget is exceeded', () => {
		const total = LOG_RETENTION_LINE_LIMIT + 600
		for (let index = 0; index < total; index++) logger.info(`超限 ${index}`)

		// Eviction is chunk-granular, so the bound includes the newest chunk and
		// the pending tail (at most 2 * CHUNK_LINE_LIMIT - 1 entries).
		expect(service.stats.lines).toBeLessThanOrEqual(
			LOG_RETENTION_LINE_LIMIT + 512,
		)
		const lines = service.collectLogs().split('\n')
		expect(lines).toHaveLength(service.stats.lines)
		expect(lines[lines.length - 1]).toContain(`超限 ${total - 1}`)
		expect(lines[0]).not.toContain('超限 0')
	})

	it('attaches its reporter idempotently across repeated onload()', () => {
		service.onload()
		service.onload()

		logger.info('只应留存一次')

		expect(service.collectLogs().split('\n')).toHaveLength(1)
	})

	it('stops retaining after onunload() and resumes after onload()', () => {
		logger.info('卸载前')
		service.onunload()
		logger.info('卸载后不应留存')

		expect(service.collectLogs()).toContain('卸载前')
		expect(service.collectLogs()).not.toContain('卸载后不应留存')

		service.onload()
		logger.info('重新装载后')
		expect(service.collectLogs()).toContain('重新装载后')
	})

	it('keeps multilingual and emoji content byte-exact', () => {
		const message = '同步完成 ✅ ファイル：議事録_2026.md — naïve café 🌏'
		const detail = { 数量: 3, label: 'résumé — naïve' }

		logger.info(message, detail)

		const saved = service.collectLogs()
		expect(saved).toContain(message)
		expect(saved).toContain('résumé — naïve')
		expect(saved).toContain('数量')
	})

	it('does not truncate an argument larger than one megabyte', () => {
		const large = `${'汉'.repeat(300_000)}${'🌏'.repeat(50_000)}`
		expect(new TextEncoder().encode(large).byteLength).toBeGreaterThan(
			1024 * 1024,
		)

		logger.info(large)

		expect(service.collectLogs()).toContain(large)
	})

	it('does not throw when a payload cannot be formatted', () => {
		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error('hostile getter')
				},
				ownKeys() {
					throw new Error('hostile keys')
				},
			},
		)

		expect(() => logger.info('[Sync] 宿主载荷', hostile)).not.toThrow()
		expect(service.collectLogs().length).toBeGreaterThan(0)
		expect(service.stats.lines).toBe(1)
	})

	it('clear() empties the retention and later logs start fresh', () => {
		logger.info('清理前 一')
		logger.info('清理前 二')
		service.clear()

		expect(service.collectLogs()).toBe('')
		expect(service.stats.lines).toBe(0)

		logger.info('清理后')
		expect(service.collectLogs().split('\n')).toHaveLength(1)
		expect(service.collectLogs()).toContain('清理后')
	})
})

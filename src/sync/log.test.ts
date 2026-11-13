import type { ConsolaReporter, LogObject } from 'consola'
import { LogLevels } from 'consola'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import logger from '~/utils/logger'
import {
	createSyncLogger,
	formatSyncLogPrefix,
	getSyncPolicyLabel,
} from './log'

/**
 * Real reporter attached to the shared logger: the forwarding behavior of
 * `createSyncLogger` is observed end-to-end instead of through method spies.
 */
const captured: LogObject[] = []
const capturingReporter: ConsolaReporter = {
	log: (logObj) => {
		captured.push(logObj)
	},
}

beforeEach(() => {
	captured.length = 0
	// `test/vitest.setup.ts` pins the shared logger to silent.
	logger.level = LogLevels.verbose
	logger.addReporter(capturingReporter)
})

afterEach(() => {
	logger.removeReporter(capturingReporter)
	logger.level = LogLevels.silent
	vi.restoreAllMocks()
})

describe('sync log helpers', () => {
	it('formats prefix with trigger mode and sync policy', () => {
		expect(
			formatSyncLogPrefix({
				mode: 'auto_sync',
				policy: 'receive-only-revert-local-changes',
			}),
		).toBe('[[Auto][ReceiveOnlyRevert]]')
		expect(
			formatSyncLogPrefix({
				mode: 'manual_sync',
				policy: 'two-way',
			}),
		).toBe('[[Manual][TwoWay]]')
	})

	it('uses concise stable policy labels', () => {
		expect(getSyncPolicyLabel('send-only')).toBe('SendOnly')
		expect(getSyncPolicyLabel('send-only-override-changes')).toBe(
			'SendOnlyOverride',
		)
	})

	it('prefixes string and object logs consistently', () => {
		const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger)
		const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => logger)
		const log = createSyncLogger('[[Auto][TwoWay]]')

		log.info('[Sync] Completed')
		log.debug({ total: 3 })

		expect(infoSpy).toHaveBeenCalledWith('[[Auto][TwoWay]] [Sync] Completed')
		expect(debugSpy).toHaveBeenCalledWith('[[Auto][TwoWay]]', { total: 3 })
	})
})

describe('createSyncLogger forwarding', () => {
	it('prefixes string messages and forwards trailing args unchanged', () => {
		const prefix = formatSyncLogPrefix({ mode: 'auto_sync', policy: 'two-way' })
		const log = createSyncLogger(prefix)

		log.info('同步完成 ✅', '文件：示例.md', 3)

		const entry = captured.find((logObj) => logObj.type === 'info')
		expect(entry?.args).toEqual([`${prefix} 同步完成 ✅`, '文件：示例.md', 3])
	})

	it('forwards object payloads by reference and does not mutate them', () => {
		const prefix = formatSyncLogPrefix({
			mode: 'manual_sync',
			policy: 'receive-only',
		})
		const log = createSyncLogger(prefix)
		const payload = {
			总数: 3,
			label: 'résumé naïve 🌏',
			nested: { 状态: '完成 ✅' },
		}
		const snapshot = JSON.parse(JSON.stringify(payload)) as typeof payload

		log.warn(payload)

		const entry = captured.find((logObj) => logObj.type === 'warn')
		expect(entry?.args).toHaveLength(2)
		expect(entry?.args[0]).toBe(prefix)
		expect(entry?.args[1]).toBe(payload)
		expect(payload).toEqual(snapshot)
	})

	it('forwards string and object payloads for every log level', () => {
		const levels = ['debug', 'info', 'warn', 'error'] as const
		const prefix = formatSyncLogPrefix({
			mode: 'auto_sync',
			policy: 'send-only',
		})
		const log = createSyncLogger(prefix)
		const payload = { 数量: 2, label: '示例 🌿' }

		for (const level of levels) {
			log[level]('事件', payload)
		}

		for (const level of levels) {
			const entry = captured.find((logObj) => logObj.type === level)
			expect(entry?.args).toEqual([`${prefix} 事件`, payload])
		}
	})
})

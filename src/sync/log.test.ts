import { describe, expect, it, vi } from 'vitest'
import logger from '~/utils/logger'
import {
	createSyncLogger,
	formatSyncLogPrefix,
	getSyncPolicyLabel,
} from './log'

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

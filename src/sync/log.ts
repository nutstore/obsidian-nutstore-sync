import logger from '~/utils/logger'

type LogMethod = (messageOrData?: unknown, ...args: unknown[]) => void

export type SyncLogger = {
	debug: LogMethod
	info: LogMethod
	warn: LogMethod
	error: LogMethod
}

type SyncTriggerMode = 'manual_sync' | 'auto_sync'
type SyncPolicyValue =
	| 'two-way'
	| 'send-only'
	| 'send-only-override-changes'
	| 'receive-only'
	| 'receive-only-revert-local-changes'

export function getSyncTriggerLabel(mode: SyncTriggerMode): 'Manual' | 'Auto' {
	return mode === 'manual_sync' ? 'Manual' : 'Auto'
}

export function getSyncPolicyLabel(policy: SyncPolicyValue): string {
	switch (policy) {
		case 'send-only':
			return 'SendOnly'
		case 'send-only-override-changes':
			return 'SendOnlyOverride'
		case 'receive-only':
			return 'ReceiveOnly'
		case 'receive-only-revert-local-changes':
			return 'ReceiveOnlyRevert'
		case 'two-way':
		default:
			return 'TwoWay'
	}
}

export function formatSyncLogPrefix(input: {
	mode: SyncTriggerMode
	policy: SyncPolicyValue
}): string {
	return `[[${getSyncTriggerLabel(input.mode)}][${getSyncPolicyLabel(input.policy)}]]`
}

function prefixMessage(prefix: string, message: string): string {
	return `${prefix} ${message}`
}

export function createSyncLogger(prefix: string) {
	return {
		debug: (messageOrData?: unknown, ...args: unknown[]) => {
			if (typeof messageOrData === 'string') {
				logger.debug(prefixMessage(prefix, messageOrData), ...args)
				return
			}
			logger.debug(prefix, messageOrData, ...args)
		},
		info: (messageOrData?: unknown, ...args: unknown[]) => {
			if (typeof messageOrData === 'string') {
				logger.info(prefixMessage(prefix, messageOrData), ...args)
				return
			}
			logger.info(prefix, messageOrData, ...args)
		},
		warn: (messageOrData?: unknown, ...args: unknown[]) => {
			if (typeof messageOrData === 'string') {
				logger.warn(prefixMessage(prefix, messageOrData), ...args)
				return
			}
			logger.warn(prefix, messageOrData, ...args)
		},
		error: (messageOrData?: unknown, ...args: unknown[]) => {
			if (typeof messageOrData === 'string') {
				logger.error(prefixMessage(prefix, messageOrData), ...args)
				return
			}
			logger.error(prefix, messageOrData, ...args)
		},
	}
}

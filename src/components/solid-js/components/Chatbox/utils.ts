import { ChatTaskRecord, ChatRunState } from './types'
import { t } from './i18n'

export function formatTime(timestamp: number) {
	return new Intl.DateTimeFormat(undefined, {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(timestamp)
}

export function formatFragmentTime(timestamp: number) {
	return new Intl.DateTimeFormat(undefined, {
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(timestamp)
}

export function formatDuration(task: ChatTaskRecord) {
	if (!('startedAt' in task) || typeof task.startedAt !== 'number') {
		return ''
	}
	const end =
		'finishedAt' in task && typeof task.finishedAt === 'number'
			? task.finishedAt
			: Date.now()
	const totalSeconds = Math.max(0, Math.floor((end - task.startedAt) / 1000))
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`
	}
	return `${seconds}s`
}

export function formatUsage(input?: number, output?: number, total?: number) {
	if (
		typeof input !== 'number' &&
		typeof output !== 'number' &&
		typeof total !== 'number'
	) {
		return ''
	}
	const parts = []
	if (typeof total === 'number') {
		parts.push(`Tokens: ${total}`)
	}
	if (typeof input === 'number') {
		parts.push(`↑${input}`)
	}
	if (typeof output === 'number') {
		parts.push(`↓${output}`)
	}
	return parts.join(' ')
}

export function statusLabel(status: ChatTaskRecord['status']) {
	switch (status) {
		case 'queued':
			return t('taskQueued')
		case 'running':
			return t('taskRunning')
		case 'completed':
			return t('taskCompleted')
		case 'failed':
			return t('taskFailed')
		case 'cancelled':
			return t('taskCancelled')
	}
}

export function statusClass(status: ChatTaskRecord['status']) {
	switch (status) {
		case 'running':
			return 'bg-[var(--color-green-rgb)]/12 text-[var(--text-accent)]'
		case 'completed':
			return 'bg-[var(--color-cyan-rgb)]/12 text-[var(--text-normal)]'
		case 'failed':
			return 'bg-[var(--color-red-rgb)]/12 text-[var(--text-error)]'
		case 'cancelled':
			return 'bg-[var(--background-secondary)] text-[var(--text-muted)]'
		default:
			return 'bg-[var(--background-secondary)] text-[var(--text-normal)]'
	}
}

export function runStateLabel(runState: ChatRunState) {
	switch (runState) {
		case 'thinking':
			return t('thinking')
		case 'compressing':
			return t('compressing')
		case 'waiting_for_tools':
			return t('processingTools')
		default:
			return ''
	}
}

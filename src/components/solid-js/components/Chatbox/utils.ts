import type { ChatDisplayToolCallBlock, ChatRunState } from '~/ai/chat/types'
import { t } from '../../i18n'

export function formatTime(timestamp: number) {
	return new Intl.DateTimeFormat(undefined, {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(timestamp)
}

export function formatDuration(durationMs: number) {
	const milliseconds = Math.max(0, Math.round(durationMs))
	if (milliseconds < 1000) return `${milliseconds}ms`
	const seconds = Math.floor(milliseconds / 1000)
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	if (minutes < 60)
		return `${minutes}m ${String(remainingSeconds).padStart(2, '0')}s`
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return `${hours}h ${String(remainingMinutes).padStart(2, '0')}m`
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

export function formatToolResult(
	toolCall: ChatDisplayToolCallBlock['toolCall'],
) {
	if (toolCall.state === 'output-error') return toolCall.errorText
	if (toolCall.state !== 'output-available') return ''
	return typeof toolCall.output === 'string'
		? toolCall.output
		: (JSON.stringify(toolCall.output, null, 2) ?? String(toolCall.output))
}

export function runStateLabel(runState: ChatRunState) {
	switch (runState) {
		case 'thinking':
			return t('chatbox.ui.states.thinking')
		case 'compressing':
			return t('chatbox.ui.states.compressing')
		case 'waiting_for_tools':
			return t('chatbox.ui.states.processingTools')
		default:
			return ''
	}
}

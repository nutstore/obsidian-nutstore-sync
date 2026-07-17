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

import type { ChatDisplayToolCallBlock, ChatRunState } from '~/ai/chat/types'
export { formatDuration } from '~/utils/format-duration'
import { t } from '../i18n'

function formatTimeFallback(timestamp: number) {
	const date = new Date(timestamp)
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatTime(timestamp: number) {
	try {
		if (
			typeof Intl !== 'undefined' &&
			typeof Intl.DateTimeFormat === 'function'
		) {
			return new Intl.DateTimeFormat(undefined, {
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			}).format(timestamp)
		}
	} catch {
		// Fall back for old or partial WebView Intl implementations.
	}
	return formatTimeFallback(timestamp)
}

interface ChatInputKeyEvent {
	key: string
	shiftKey: boolean
	isComposing: boolean
	/** Legacy WebKit/IME composition sentinel. */
	keyCode: number
}

export function shouldSubmitChatInput(
	event: ChatInputKeyEvent,
	compositionActive: boolean,
) {
	return (
		event.key === 'Enter' &&
		!event.shiftKey &&
		!compositionActive &&
		!event.isComposing &&
		event.keyCode !== 229
	)
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

export function toolCallPurpose(
	toolCall: ChatDisplayToolCallBlock['toolCall'],
) {
	const input = toolCall.input
	if (input && typeof input === 'object' && !Array.isArray(input)) {
		const purpose = (input as Record<string, unknown>).purpose
		if (typeof purpose === 'string' && purpose.trim() !== '') {
			return purpose.trim()
		}
	}
	return undefined
}

export function toolCallDisplayTitle(
	toolCall: ChatDisplayToolCallBlock['toolCall'],
) {
	return toolCallPurpose(toolCall) ?? toolCall.toolName
}

export function fencedCode(language: string, value: string) {
	const longestBacktickRun = Math.max(
		0,
		...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
	)
	const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
	return `${fence}${language}\n${value}\n${fence}`
}

export function stringifyJsonValue(value: unknown) {
	try {
		return JSON.stringify(value ?? {}, null, 2)
	} catch {
		return value instanceof Error ? value.message : '[Unserializable value]'
	}
}

export function formatToolDetailsMarkdown(params?: unknown, result?: string) {
	const lines: string[] = []
	if (params !== undefined) {
		lines.push(`${t('chatbox.ui.labels.params')}:`, '')
		lines.push(fencedCode('json', stringifyJsonValue(params)))
	}
	const resultText = result?.trim()

	if (resultText) {
		lines.push(
			'',
			`${t('chatbox.ui.labels.result')}:`,
			'',
			fencedCode('text', resultText),
		)
	}

	return lines.join('\n')
}

export function formatSystemNotificationMarkdown(notification: unknown) {
	return fencedCode('json', stringifyJsonValue(notification))
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

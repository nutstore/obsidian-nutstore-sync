import type {
	AssistantModelMessage,
	FilePart,
	TextPart,
	ToolCallPart,
} from 'ai'
import type { AIMessage } from '~/ai/core/types'
import type { ChatMessage } from '~/ai/chat/types'
import i18n from '~/i18n'

const DEFAULT_IMAGE_MEDIA_TYPE = 'image/png'

function normalizeImageMediaType(mediaType: unknown) {
	return typeof mediaType === 'string' && mediaType.trim()
		? mediaType.trim()
		: DEFAULT_IMAGE_MEDIA_TYPE
}

function isImageMediaType(mediaType: unknown) {
	if (typeof mediaType !== 'string') return false
	const normalized = mediaType.toLowerCase()
	return normalized === 'image' || normalized.startsWith('image/')
}

export function toImageFilePart(
	data: FilePart['data'],
	options?: Pick<FilePart, 'mediaType' | 'filename' | 'providerOptions'>,
): FilePart {
	return {
		type: 'file',
		data,
		mediaType: normalizeImageMediaType(options?.mediaType),
		...(options?.filename ? { filename: options.filename } : {}),
		...(options?.providerOptions
			? { providerOptions: options.providerOptions }
			: {}),
	}
}

export function isImageFilePart(part: unknown): part is FilePart {
	const p = part as Partial<FilePart> | undefined
	return p?.type === 'file' && isImageMediaType(p.mediaType)
}

export function imageFilePartSrc(part: unknown): string | undefined {
	if (!isImageFilePart(part)) return undefined
	if (typeof part.data === 'string') return part.data.trim() || undefined
	if (part.data instanceof URL) return part.data.toString()
	return undefined
}

export function toTextParts(text: string): TextPart[] {
	return [{ type: 'text', text }]
}

export function messageToText(
	message: Pick<ChatMessage, 'content'> | AIMessage,
) {
	if (!message.content) {
		return ''
	}
	if (typeof message.content === 'string') {
		return message.content
	}
	return (message.content as Array<{ type: string; text?: string }>)
		.filter((part) => part.type === 'text')
		.map((part) => part.text ?? '')
		.join('\n')
}

export function getAssistantToolCalls(
	message: ChatMessage,
): ToolCallPart[] | undefined {
	if (message.role !== 'assistant' || !Array.isArray(message.content)) {
		return undefined
	}
	const calls = (message.content as Array<{ type: string }>).filter(
		(p): p is ToolCallPart => p.type === 'tool-call',
	)
	return calls.length > 0 ? calls : undefined
}

export function migrateMessageFromV0(msg: unknown): ChatMessage {
	if (!msg || typeof msg !== 'object') {
		return msg as ChatMessage
	}
	const m = msg as Record<string, unknown>
	const role = m.role as string

	if (role === 'assistant') {
		const oldContent = Array.isArray(m.content) ? m.content : []
		const oldToolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : []
		const contentParts: unknown[] = oldContent.map((part: unknown) => {
			const p = part as Record<string, unknown>
			if (p.type === 'image_url' && p.image_url) {
				const iu = p.image_url as Record<string, unknown>
				return toImageFilePart(iu.url as FilePart['data'])
			}
			if (p.type === 'unknown') {
				return { type: 'text', text: JSON.stringify(p.value) }
			}
			return { type: 'text', text: p.text ?? '' }
		})
		const toolCallParts = oldToolCalls.map((tc: unknown) => {
			const t = tc as Record<string, unknown>
			const fn = (t.function ?? {}) as Record<string, unknown>
			let input: unknown = {}
			try {
				input = JSON.parse((fn.arguments as string) || '{}')
			} catch (_e) {
				// keep default empty object
			}
			return {
				type: 'tool-call',
				toolCallId: t.id,
				toolName: fn.name,
				input,
			}
		})
		return {
			role: 'assistant',
			content: [...contentParts, ...toolCallParts],
		} as ChatMessage
	}

	if (role === 'tool') {
		const oldContent = Array.isArray(m.content) ? m.content : []
		const textValue = oldContent
			.filter((p: unknown) => (p as Record<string, unknown>).type === 'text')
			.map((p: unknown) => (p as Record<string, string>).text)
			.join('\n')
		return {
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: m.tool_call_id as string,
					toolName: m.name as string,
					output: { type: 'text', value: textValue },
				},
			],
		} as ChatMessage
	}

	if (role === 'user') {
		const oldContent = Array.isArray(m.content) ? m.content : []
		const parts = oldContent.map((part: unknown) => {
			const p = part as Record<string, unknown>
			if (p.type === 'image_url' && p.image_url) {
				const iu = p.image_url as Record<string, unknown>
				return toImageFilePart(iu.url as FilePart['data'])
			}
			if (p.type === 'unknown') {
				return { type: 'text', text: JSON.stringify(p.value) }
			}
			return { type: 'text', text: p.text ?? '' }
		})
		return { role: 'user', content: parts } as ChatMessage
	}

	return msg as ChatMessage
}

export function needsV0Migration(msg: unknown): boolean {
	if (!msg || typeof msg !== 'object') return false
	const m = msg as Record<string, unknown>
	return (
		(m.role === 'assistant' && 'tool_calls' in m) ||
		(m.role === 'tool' && 'tool_call_id' in m)
	)
}

function migrateImagePartsToFiles(content: unknown): unknown {
	if (!Array.isArray(content)) return content
	let changed = false
	const next = content.map((part) => {
		const p = part as Record<string, unknown>
		if (p?.type === 'image' && 'image' in p) {
			changed = true
			return toImageFilePart(p.image as FilePart['data'], {
				mediaType: normalizeImageMediaType(p.mediaType),
				providerOptions: p.providerOptions as FilePart['providerOptions'],
			})
		}
		return part
	})
	return changed ? next : content
}

export function migrateDeprecatedImageParts(msg: unknown): ChatMessage {
	if (!msg || typeof msg !== 'object') {
		return msg as ChatMessage
	}
	const m = msg as Record<string, unknown>
	const content = m.content
	const migrated = migrateImagePartsToFiles(content)
	if (migrated === content) {
		return msg as ChatMessage
	}
	return { ...(msg as object), content: migrated } as ChatMessage
}

export function needsDeprecatedImagePartMigration(msg: unknown): boolean {
	if (!msg || typeof msg !== 'object') return false
	const m = msg as Record<string, unknown>
	const content = m.content
	if (!Array.isArray(content)) return false
	return content.some((part) => {
		const p = part as Record<string, unknown>
		return p?.type === 'image' && 'image' in p
	})
}

export function deriveTitle(session: {
	fragments: Array<{ messages: Array<{ message: ChatMessage }> }>
}) {
	for (const fragment of session.fragments) {
		const firstUser = fragment.messages.find(
			(item) => item.message.role === 'user',
		)
		const content = firstUser ? messageToText(firstUser.message).trim() : ''
		if (content) {
			return content
		}
	}
	return i18n.t('chatbox.newChat')
}

export type { AssistantModelMessage, FilePart, TextPart, ToolCallPart }

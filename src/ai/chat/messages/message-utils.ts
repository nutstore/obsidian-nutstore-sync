import type { FilePart, ModelMessage, UserModelMessage } from 'ai'
import i18n from '~/i18n'
import type { ChatSession } from '~/ai/chat/domain'
import { getMessageText } from '~/ai/chat/messages/ui-message'

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

export function messageToText(message: Pick<ModelMessage, 'content'>) {
	if (typeof message.content === 'string') {
		return message.content
	}
	return (message.content as Array<{ type: string; text?: string }>)
		.filter((part) => part.type === 'text')
		.map((part) => part.text ?? '')
		.join('\n')
}
export function migrateMessageFromV0(msg: unknown): ModelMessage {
	if (!msg || typeof msg !== 'object') {
		return msg as ModelMessage
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
		} as ModelMessage
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
		}
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
		return { role: 'user', content: parts } as ModelMessage
	}

	return msg as ModelMessage
}

export function needsV0Migration(msg: unknown): boolean {
	if (!msg || typeof msg !== 'object') return false
	const m = msg as Record<string, unknown>
	return (
		(m.role === 'assistant' && 'tool_calls' in m) ||
		(m.role === 'tool' && 'tool_call_id' in m)
	)
}

function migrateImagePartsToFiles(
	content: UserModelMessage['content'],
): UserModelMessage['content'] {
	if (typeof content === 'string') return content
	let changed = false
	const next = content.map((part) => {
		if (part.type === 'image') {
			changed = true
			return toImageFilePart(part.image, {
				mediaType: normalizeImageMediaType(part.mediaType),
				providerOptions: part.providerOptions,
			})
		}
		return part
	})
	return changed ? next : content
}

export function migrateDeprecatedImageParts(msg: ModelMessage): ModelMessage {
	if (msg.role !== 'user') return msg
	const migrated = migrateImagePartsToFiles(msg.content)
	if (migrated === msg.content) return msg
	return { ...msg, content: migrated }
}

export function needsDeprecatedImagePartMigration(msg: ModelMessage): boolean {
	if (msg.role !== 'user' || typeof msg.content === 'string') return false
	return msg.content.some((part) => part.type === 'image')
}

export function deriveTitle(session: ChatSession) {
	for (const message of session.subagents.master.timeline) {
		if (message.role !== 'user') continue
		const content = getMessageText(message).trim()
		if (content) return content
	}
	return i18n.t('chatbox.newChat')
}

import type {
	ChatDisplayBlock,
	ChatMessageContentPart,
	ChatMessageRecord,
	ToolCallPart,
} from '~/ai/chat/types'

function isContentPart(
	part: ChatMessageContentPart,
): part is Exclude<ChatMessageContentPart, ToolCallPart> {
	return (
		part.type === 'text' || part.type === 'reasoning' || part.type === 'image'
	)
}

function hasRenderableContent(
	part: Exclude<ChatMessageContentPart, ToolCallPart>,
) {
	if (part.type === 'image') {
		return typeof part.image === 'string'
			? part.image.trim().length > 0
			: Boolean(part.image)
	}
	return (part.text ?? '').trim().length > 0
}

function getToolResultCallId(record: ChatMessageRecord) {
	if (
		record.message.role !== 'tool' ||
		!Array.isArray(record.message.content)
	) {
		return undefined
	}
	const firstPart = record.message.content[0] as
		| { type?: string; toolCallId?: string }
		| undefined
	return firstPart?.type === 'tool-result' ? firstPart.toolCallId : undefined
}

function findMatchingToolMessage(
	messages: ChatMessageRecord[],
	afterIndex: number,
	toolCallId: string,
	consumedToolMessageIds: Set<string>,
) {
	for (let index = afterIndex + 1; index < messages.length; index += 1) {
		const candidate = messages[index]
		if (consumedToolMessageIds.has(candidate.id)) continue
		if (getToolResultCallId(candidate) !== toolCallId) continue
		return candidate
	}
	return undefined
}

function buildMessageDisplayBlocks(
	messages: ChatMessageRecord[],
	messageIndex: number,
	consumedToolMessageIds: Set<string>,
): ChatDisplayBlock[] {
	const record = messages[messageIndex]
	if (!Array.isArray(record.message.content)) {
		return []
	}
	const parts = record.message.content as ChatMessageContentPart[]
	if (record.message.role === 'tool') {
		return consumedToolMessageIds.has(record.id)
			? []
			: [{ kind: 'tool-result', toolMessage: record }]
	}

	const blocks: ChatDisplayBlock[] = []
	let pendingContent: Array<Exclude<ChatMessageContentPart, ToolCallPart>> = []

	const flushContent = () => {
		if (!pendingContent.length) return
		blocks.push({ kind: 'content', parts: pendingContent })
		pendingContent = []
	}

	for (const part of parts) {
		if (isContentPart(part)) {
			if (!hasRenderableContent(part)) {
				continue
			}
			pendingContent.push(part)
			continue
		}
		if (part.type !== 'tool-call') {
			continue
		}
		flushContent()
		const matchingToolMessage = findMatchingToolMessage(
			messages,
			messageIndex,
			part.toolCallId,
			consumedToolMessageIds,
		)
		if (matchingToolMessage) {
			consumedToolMessageIds.add(matchingToolMessage.id)
		}
		blocks.push({
			kind: 'tool-call',
			toolCall: part,
			toolMessage: matchingToolMessage,
		})
	}

	flushContent()
	return blocks
}

export interface ProjectedMessageGroup {
	record: ChatMessageRecord
	blocks: ChatDisplayBlock[]
}

export function projectFragmentMessageGroups(messages: ChatMessageRecord[]) {
	const consumedToolMessageIds = new Set<string>()
	const groups: ProjectedMessageGroup[] = []

	for (let index = 0; index < messages.length; index += 1) {
		const record = messages[index]
		if (record.message.role === 'system') continue
		const blocks = buildMessageDisplayBlocks(
			messages,
			index,
			consumedToolMessageIds,
		)
		if (!blocks.length) continue
		groups.push({ record, blocks })
	}

	return groups
}

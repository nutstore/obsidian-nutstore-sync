import type {
	AppUIMessage,
	ChatDisplayBlock,
	ChatTodoItem,
} from '~/ai/chat/types'

function todosFromMessage(message: AppUIMessage): ChatTodoItem[] | undefined {
	for (let index = message.parts.length - 1; index >= 0; index -= 1) {
		const part = message.parts[index]
		if (part.type === 'data-todos') {
			return part.data.items
		}
	}
	return undefined
}

function buildMessageDisplayBlocks(
	message: AppUIMessage,
	toolTimings: import('~/ai/chat/types').ChatAgentState['toolTimings'],
	operations: import('~/ai/chat/types').ReversibleToolOp[] = [],
) {
	const blocks: ChatDisplayBlock[] = []
	let content: Extract<ChatDisplayBlock, { kind: 'content' }>['parts'] = []
	let todos: ChatTodoItem[] | undefined
	const flush = () => {
		if (content.length) blocks.push({ kind: 'content', parts: content })
		content = []
	}

	for (const part of message.parts) {
		if (part.type === 'text') {
			if (part.text.trim()) content.push(part)
			continue
		}
		if (part.type === 'reasoning') {
			flush()
			if (part.text.trim()) blocks.push({ kind: 'reasoning', part })
			continue
		}
		if (part.type === 'data-model-file') {
			content.push(part.data.file)
			continue
		}
		if (part.type === 'data-system-notification') {
			flush()
			blocks.push({
				kind: 'system-notification',
				notification: part.data,
			})
			continue
		}
		if (part.type === 'dynamic-tool') {
			flush()
			const block: Extract<ChatDisplayBlock, { kind: 'tool-call' }> = {
				kind: 'tool-call',
				toolCall: part,
				timing: toolTimings[part.toolCallId],
			}
			const fileChanges = operations.filter(
				(operation) => operation.toolCallId === part.toolCallId,
			)
			if (fileChanges.length) block.fileChanges = fileChanges
			if (part.toolName === 'todowrite') {
				todos ??= todosFromMessage(message)
				if (todos) block.todos = todos
			}
			blocks.push(block)
		}
	}
	flush()
	return blocks
}

export function projectTimelineMessageGroups(
	messages: AppUIMessage[],
	toolTimings: import('~/ai/chat/types').ChatAgentState['toolTimings'] = {},
	operations: import('~/ai/chat/types').ChatAgentState['operations'] = {},
) {
	return messages.flatMap((message) => {
		if (message.role === 'system') return []
		const blocks = buildMessageDisplayBlocks(
			message,
			toolTimings,
			operations[message.id],
		)
		const hasContext = message.parts.some(
			(part) => part.type === 'data-user-context',
		)
		return blocks.length || hasContext ? [{ message, blocks }] : []
	})
}

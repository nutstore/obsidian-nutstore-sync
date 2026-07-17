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

function buildMessageDisplayBlocks(message: AppUIMessage) {
	const blocks: ChatDisplayBlock[] = []
	let content: Extract<ChatDisplayBlock, { kind: 'content' }>['parts'] = []
	let todos: ChatTodoItem[] | undefined
	const flush = () => {
		if (content.length) blocks.push({ kind: 'content', parts: content })
		content = []
	}

	for (const part of message.parts) {
		if (part.type === 'text' || part.type === 'reasoning') {
			if (part.text.trim()) content.push(part)
			continue
		}
		if (part.type === 'data-model-file') {
			content.push(part.data.file)
			continue
		}
		if (part.type === 'dynamic-tool') {
			flush()
			const block: Extract<ChatDisplayBlock, { kind: 'tool-call' }> = {
				kind: 'tool-call',
				toolCall: part,
			}
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

export function projectTimelineMessageGroups(messages: AppUIMessage[]) {
	return messages.flatMap((message) => {
		if (message.role === 'system') return []
		const blocks = buildMessageDisplayBlocks(message)
		const hasContext = message.parts.some(
			(part) => part.type === 'data-user-context',
		)
		return blocks.length || hasContext ? [{ message, blocks }] : []
	})
}

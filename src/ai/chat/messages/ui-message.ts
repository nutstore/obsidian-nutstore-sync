import type {
	FilePart,
	ModelMessage,
	ProviderMetadata,
	TextPart,
	ToolCallPart,
	DynamicToolUIPart,
	UserModelMessage,
} from 'ai'
import { convertToModelMessages, type ToolSet } from 'ai'
import type {
	AppUIMessage,
	AppUIMessagePart,
	ChatAgentState,
	ChatMessageMeta,
	ChatTodoItem,
	LegacyChatMessageRecord,
	ReversibleToolOp,
	WorkspaceContextDelta,
} from '~/ai/chat/types'
import { MASTER_AGENT_ID } from '~/ai/chat/agents/registry'
import { CHECKPOINT_PREAMBLE } from '~/ai/chat/prompts'
import type { UserContextManager } from '~/ai/chat/context/user-context-manager'

function modelFilePartToDataPart(file: FilePart): AppUIMessagePart {
	return { type: 'data-model-file', data: { file } }
}

function modelPartToUIPart(part: unknown): AppUIMessagePart | undefined {
	if (!part || typeof part !== 'object') return undefined
	const value = part as Record<string, unknown>
	if (value.type === 'text') {
		return {
			type: 'text',
			text: typeof value.text === 'string' ? value.text : '',
			...(value.providerOptions
				? { providerMetadata: value.providerOptions as ProviderMetadata }
				: {}),
		}
	}
	if (value.type === 'reasoning') {
		return {
			type: 'reasoning',
			text: typeof value.text === 'string' ? value.text : '',
			state: 'done',
			...(value.providerOptions
				? { providerMetadata: value.providerOptions as ProviderMetadata }
				: {}),
		}
	}
	if (value.type === 'file') {
		return modelFilePartToDataPart(part as FilePart)
	}
	if (value.type === 'tool-call') {
		const toolCall = part as ToolCallPart
		return {
			type: 'dynamic-tool',
			toolName: toolCall.toolName,
			toolCallId: toolCall.toolCallId,
			state: 'input-available',
			input: toolCall.input,
			...(value.providerExecuted === true ? { providerExecuted: true } : {}),
			...(value.providerOptions
				? {
						callProviderMetadata: value.providerOptions as ProviderMetadata,
					}
				: {}),
		}
	}
	if (value.type === 'custom' && typeof value.kind === 'string') {
		return {
			type: 'custom',
			kind: value.kind as `${string}.${string}`,
			...(value.providerOptions
				? { providerMetadata: value.providerOptions as ProviderMetadata }
				: {}),
		}
	}
	return undefined
}

function messageContentParts(message: ModelMessage): unknown[] {
	if (typeof message.content === 'string') {
		return [{ type: 'text', text: message.content }]
	}
	return Array.isArray(message.content) ? [...message.content] : []
}

export function modelMessageToUIMessage(
	message: ModelMessage,
	options: {
		id: string
		createdAt: number
		meta?: ChatMessageMeta
		isError?: boolean
		workspaceContextDelta?: WorkspaceContextDelta[]
		userContext?: LegacyChatMessageRecord['userContext']
		todos?: ChatTodoItem[]
	},
): AppUIMessage {
	const parts = messageContentParts(message)
		.map(modelPartToUIPart)
		.filter((part): part is AppUIMessagePart => !!part)

	if (options.workspaceContextDelta?.length) {
		parts.unshift({
			type: 'data-workspace-context',
			data: { deltas: options.workspaceContextDelta },
		})
	}
	if (options.userContext?.length) {
		parts.unshift({
			type: 'data-user-context',
			data: { items: options.userContext },
		})
	}
	if (options.todos?.length) {
		parts.push({ type: 'data-todos', data: { items: options.todos } })
	}

	return {
		id: options.id,
		role: message.role === 'tool' ? 'assistant' : message.role,
		metadata: {
			createdAt: options.createdAt,
			...(options.meta ? { llm: options.meta } : {}),
			...(options.isError ? { status: 'error' as const } : {}),
		},
		parts,
	}
}

function toolOutputValue(output: unknown): unknown {
	if (!output || typeof output !== 'object') return output
	const value = output as Record<string, unknown>
	if (
		(value.type === 'text' || value.type === 'error-text') &&
		typeof value.value === 'string'
	) {
		return value.value
	}
	if (value.type === 'json' || value.type === 'error-json') return value.value
	return output
}

function legacyToolPart(
	result: Record<string, unknown>,
	toolCallId: string,
	previous: DynamicToolUIPart | undefined,
	isError: boolean,
): DynamicToolUIPart {
	const output = toolOutputValue(result.output)
	const common = {
		type: 'dynamic-tool' as const,
		toolName:
			typeof result.toolName === 'string'
				? result.toolName
				: (previous?.toolName ?? 'unknown-tool'),
		toolCallId,
		input: previous && 'input' in previous ? previous.input : undefined,
	}
	return isError
		? {
				...common,
				state: 'output-error',
				errorText:
					typeof output === 'string'
						? output
						: (JSON.stringify(output) ?? String(output)),
			}
		: { ...common, state: 'output-available', output }
}

export function mergeLegacyToolRecord(
	timeline: AppUIMessage[],
	record: LegacyChatMessageRecord,
	operations: Record<string, ReversibleToolOp[]>,
) {
	const rawParts = messageContentParts(record.message)
	const targets: AppUIMessage[] = []
	const orphanParts: DynamicToolUIPart[] = []
	for (const rawPart of rawParts) {
		if (!rawPart || typeof rawPart !== 'object') continue
		const result = rawPart as Record<string, unknown>
		if (
			result.type !== 'tool-result' ||
			typeof result.toolCallId !== 'string'
		) {
			continue
		}
		let target: AppUIMessage | undefined
		for (let index = timeline.length - 1; index >= 0; index -= 1) {
			const message = timeline[index]
			const partIndex = message.parts.findIndex(
				(part) =>
					part.type === 'dynamic-tool' && part.toolCallId === result.toolCallId,
			)
			if (partIndex < 0) continue
			const previous = message.parts[partIndex]
			if (previous.type !== 'dynamic-tool') continue
			message.parts[partIndex] = legacyToolPart(
				result,
				result.toolCallId,
				previous,
				Boolean(record.isError),
			)
			target = message
			break
		}
		if (target) {
			if (!targets.includes(target)) targets.push(target)
		} else {
			orphanParts.push(
				legacyToolPart(
					result,
					result.toolCallId,
					undefined,
					Boolean(record.isError),
				),
			)
		}
	}

	if (orphanParts.length) {
		const orphanMessage: AppUIMessage = {
			id: record.id,
			role: 'assistant',
			metadata: {
				createdAt: record.createdAt,
				...(record.isError ? { status: 'error' as const } : {}),
			},
			parts: orphanParts,
		}
		timeline.push(orphanMessage)
		targets.push(orphanMessage)
	}

	const metadataTarget = targets[targets.length - 1]
	if (metadataTarget) {
		if (record.todos?.length) {
			metadataTarget.parts.push({
				type: 'data-todos',
				data: { items: record.todos.map((todo) => ({ ...todo })) },
			})
		}
		if (record.reversibleOps?.length) {
			operations[metadataTarget.id] = [
				...(operations[metadataTarget.id] ?? []),
				...record.reversibleOps,
			]
		}
	}
}

export function getMessageText(message: AppUIMessage) {
	return message.parts
		.filter(
			(part): part is Extract<AppUIMessagePart, { type: 'text' }> =>
				part.type === 'text',
		)
		.map((part) => part.text)
		.join('\n')
}

/** Remove tool calls that cannot be resumed after their owning execution ends. */
export function removeIncompleteToolCalls(agent: ChatAgentState) {
	let changed = false
	agent.timeline = agent.timeline.filter((message) => {
		if (message.role !== 'assistant') return true
		const nextParts = message.parts.filter((part) => {
			if (part.type !== 'dynamic-tool') return true
			const complete =
				part.state === 'output-available' ||
				part.state === 'output-error' ||
				part.state === 'output-denied'
			if (!complete) changed = true
			return complete
		})
		if (nextParts.length !== message.parts.length) message.parts = nextParts
		if (
			!message.parts.length ||
			(!getMessageText(message).trim() &&
				message.parts.every((part) => part.type === 'step-start'))
		) {
			changed = true
			return false
		}
		return true
	})
	return changed
}

export function getWorkspaceContextDeltas(message: AppUIMessage) {
	return message.parts.flatMap((part) =>
		part.type === 'data-workspace-context' ? part.data.deltas : [],
	)
}

export function getUserContextItems(message: AppUIMessage) {
	return message.parts.flatMap((part) =>
		part.type === 'data-user-context' ? part.data.items : [],
	)
}

function findLastContextCheckpointIndex(messages: AppUIMessage[]) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (
			messages[index].parts.some(
				(part) => part.type === 'data-context-checkpoint',
			)
		) {
			return index
		}
	}
	return -1
}

export function selectContextTimeline(
	messages: AppUIMessage[],
): AppUIMessage[] {
	const checkpointIndex = findLastContextCheckpointIndex(messages)
	if (checkpointIndex < 0) return messages
	const checkpointMessage = messages[checkpointIndex]
	const checkpoint = checkpointMessage.parts.find(
		(part) => part.type === 'data-context-checkpoint',
	)
	if (checkpoint?.type !== 'data-context-checkpoint') return messages
	if (checkpoint.data.mode === 'reset') {
		return messages.slice(checkpointIndex + 1)
	}
	if (checkpoint.data.summarizedThroughMessageId) {
		const priorContext = selectContextTimeline(
			messages.slice(0, checkpointIndex),
		)
		const summarizedThroughIndex = priorContext.findIndex(
			(message) => message.id === checkpoint.data.summarizedThroughMessageId,
		)
		if (summarizedThroughIndex < 0) {
			const retainedIds = checkpoint.data.retainedMessageIds
			const retainedMessages = retainedIds
				? retainedIds.flatMap((id) => {
						const retained = priorContext.find((message) => message.id === id)
						return retained ? [retained] : []
					})
				: priorContext
			return [
				checkpointMessage,
				...retainedMessages,
				...messages.slice(checkpointIndex + 1),
			]
		}
		return [
			checkpointMessage,
			...priorContext.slice(summarizedThroughIndex + 1),
			...messages.slice(checkpointIndex + 1),
		]
	}
	if (checkpoint.data.preservedTurnCount === undefined) {
		return messages.slice(checkpointIndex)
	}

	const priorContext: AppUIMessage[] = selectContextTimeline(
		messages.slice(0, checkpointIndex),
	)
	let remainingTurns = checkpoint.data.preservedTurnCount
	let preservedStart = priorContext.length
	for (let index = priorContext.length - 1; index >= 0; index -= 1) {
		const message = priorContext[index]
		if (
			message.role !== 'user' ||
			message.parts.some((part) => part.type === 'data-context-checkpoint')
		) {
			continue
		}
		remainingTurns -= 1
		preservedStart = index
		if (remainingTurns === 0) break
	}
	return [
		checkpointMessage,
		...priorContext.slice(preservedStart),
		...messages.slice(checkpointIndex + 1),
	]
}

export async function uiMessagesToModelMessages(
	messages: AppUIMessage[],
	tools?: ToolSet,
) {
	return convertToModelMessages<AppUIMessage>(messages, {
		tools,
		convertDataPart(part): TextPart | FilePart | undefined {
			if (part.type === 'data-workspace-context') {
				return {
					type: 'text',
					text: `<AdditionalContext>${JSON.stringify(
						Object.fromEntries(
							part.data.deltas.map((entry) => [entry.key, entry.content]),
						),
					)}</AdditionalContext>`,
				}
			}
			if (part.type === 'data-context-checkpoint') {
				if (part.data.mode === 'reset' || !part.data.summary) return undefined
				return {
					type: 'text',
					text: `<ConversationSummary>\n${CHECKPOINT_PREAMBLE}\n\n${part.data.summary}\n</ConversationSummary>`,
				}
			}
			if (part.type === 'data-system-notification') {
				return {
					type: 'text',
					text: `<SystemNotification>${JSON.stringify(part.data)}</SystemNotification>`,
				}
			}
			if (part.type === 'data-model-file') {
				return part.data.file
			}
			return undefined
		},
	})
}

export function consumePendingInputs(agent: ChatAgentState) {
	const inputs = agent.pendingInputs.splice(0)
	agent.timeline.push(...inputs)
	return inputs.length > 0
}

export function assertMasterPendingInputsEmpty(agent: ChatAgentState) {
	if (agent.id === MASTER_AGENT_ID && agent.pendingInputs.length > 0) {
		throw new Error('Master agent pendingInputs must remain empty')
	}
}

/**
 * Build the model message transcript exactly as the agent loop does — the
 * shared builder behind both main turns and the compression summarizer call,
 * so both requests carry the same byte-for-byte prefix.
 */
export async function buildAgentMessages(
	agent: ChatAgentState,
	tools: ToolSet,
	userContextManager: UserContextManager,
	timeline = selectContextTimeline(agent.timeline),
): Promise<ModelMessage[]> {
	const messages = await Promise.all(
		timeline.map(async (item) => {
			const converted = await uiMessagesToModelMessages([item], tools)
			if (item.role !== 'user' || converted.length === 0) return converted
			const modelMessage = converted[0]
			const userContext = getUserContextItems(item)
			const dedupedContext = userContext.length
				? userContextManager.dedupeUserContextItems(userContext)
				: []
			const contextParts =
				await userContextManager.buildMessagePartsFromUserContext(
					dedupedContext,
				)
			if (!contextParts.length) return converted
			const userContent = Array.isArray(modelMessage.content)
				? (modelMessage as UserModelMessage).content
				: []
			return [
				{
					...modelMessage,
					content: [...contextParts, ...userContent],
				} as ModelMessage,
			]
		}),
	)
	return messages.flat()
}

export function createEmptyMasterAgent(createdAt: number): ChatAgentState {
	return {
		id: MASTER_AGENT_ID,
		type: MASTER_AGENT_ID,
		status: 'idle',
		createdAt,
		timeline: [],
		pendingInputs: [],
		operations: {},
		toolTimings: {},
		subagents: {},
	}
}

import { createPermissionGuard } from '~/ai/tools/permission-guard'
import { createAITools } from '~/ai/tools/tools'
import type {
	AIMessageRecord,
	AISession,
	AIToolCall,
	AIToolDefinition,
	AIToolExecutionContext,
	ToolExecutionResult,
} from '~/ai/core/types'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import { resolveChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '../../..'

export interface ResolvedToolResult {
	payload: string | Record<string, unknown>
	isError: boolean
	reversibleOps?: AIMessageRecord['reversibleOps']
}

export type SpawnTaskHandler = (
	rawArgs: string,
	context: AIToolExecutionContext,
) => Promise<Record<string, unknown>>

export class ToolExecutor {
	private spawnTaskHandler: SpawnTaskHandler = () =>
		Promise.resolve({
			status: 'failed',
			error_summary: 'spawn handler not set',
		})

	constructor(
		private plugin: NutstorePlugin,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
	) {}

	setSpawnTaskHandler(handler: SpawnTaskHandler) {
		this.spawnTaskHandler = handler
	}

	getChatModalMountTarget() {
		return resolveChatModalMountTarget(this.state.chatModalHostEl)
	}

	createToolsForContext(
		session: AISession,
		depth: number,
		maxDepth: number,
		parentTaskId?: string,
	) {
		const allowSpawn = depth < maxDepth
		const permissionGuard = createPermissionGuard(
			this.plugin.app,
			() => this.plugin.settings,
			{
				has: (signature) =>
					this.runtimeStates.getAutoApproveRequests(session.id).has(signature),
				add: (signature) => {
					this.runtimeStates.getAutoApproveRequests(session.id).add(signature)
				},
			},
			{
				sessionTitle:
					this.state.sessionIndex.find((item) => item.id === session.id)
						?.title || deriveTitle(session),
				modalMountTarget: this.getChatModalMountTarget(),
			},
		)
		return createAITools(this.plugin.app, {
			allowSpawn,
			permissionGuard,
			spawnTask: async (params) => ({
				task_id: null,
				parent_task_id: parentTaskId || params.parentTaskId || null,
				label: params.title || params.prompt.slice(0, 48),
				task: params.prompt,
				status: 'running',
				depth: params.depth,
				max_depth: params.maxDepth,
				async: true,
			}),
		})
	}

	async resolveToolCalls(
		toolCalls: AIToolCall[],
		tools: AIToolDefinition[],
		context: AIToolExecutionContext,
	) {
		const toolsByName = new Map(tools.map((t) => [t.name, t]))
		const results = await Promise.all(
			toolCalls.map((toolCall) =>
				this.resolveSingleToolCall(toolCall, toolsByName, context),
			),
		)

		return toolCalls.map((toolCall, index) => ({
			message: {
				role: 'tool' as const,
				content: [
					{
						type: 'tool-result' as const,
						toolCallId: toolCall.toolCallId,
						toolName: toolCall.toolName,
						output: {
							type: 'text' as const,
							value:
								typeof results[index].payload === 'string'
									? results[index].payload
									: JSON.stringify(results[index].payload, null, 2),
						},
					},
				],
			},
			isError: results[index].isError,
			reversibleOps: results[index].reversibleOps,
		}))
	}

	async resolveSingleToolCall(
		toolCall: AIToolCall,
		toolsByName: Map<string, AIToolDefinition>,
		context: AIToolExecutionContext,
	): Promise<ResolvedToolResult> {
		const inputJson = JSON.stringify(toolCall.input ?? {})
		if (toolCall.toolName === 'spawn') {
			const payload = await this.spawnTaskHandler(inputJson, context)
			return {
				payload,
				isError: payload.status !== 'completed',
			}
		}

		const result = await this.executeToolCall(
			toolsByName,
			toolCall.toolName,
			inputJson,
			context,
		)
		return {
			payload: result.payload,
			reversibleOps: result.reversibleOps,
			isError: typeof result.payload === 'object' && !!result.payload.error,
		}
	}

	async executeToolCall(
		toolsByName: Map<string, AIToolDefinition>,
		name: string,
		args: string,
		context: AIToolExecutionContext,
	) {
		const tool = toolsByName.get(name)
		let result: ToolExecutionResult

		try {
			if (!tool) {
				throw new Error(
					i18n.t('chatbox.errors.unknownTool', {
						name,
					}),
				)
			}
			const parsedArgs = JSON.parse(args) as Record<string, unknown>
			const params = tool.inputSchema.parse(parsedArgs)
			result = await tool.execute(params, context)
		} catch (error) {
			logger.error(error)
			result = {
				result: {
					error: error instanceof Error ? error.message : String(error),
				},
			}
		}

		return {
			payload: result.result,
			reversibleOps: result.reversibleOps
				?.map(normalizeReversibleToolOpRecord)
				.filter(
					(op): op is NonNullable<AIMessageRecord['reversibleOps']>[number] =>
						!!op,
				),
		}
	}

	requireToolString(value: unknown, field: string) {
		if (typeof value !== 'string' || !value.trim()) {
			throw new Error(i18n.t('chatbox.errors.toolFieldRequired', { field }))
		}
		return value.trim()
	}
}

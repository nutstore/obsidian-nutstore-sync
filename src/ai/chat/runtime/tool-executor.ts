import type { ChatSession } from '~/ai/chat/domain'

import {
	createPermissionGuard,
	createReadonlyPermissionGuard,
	createFullAccessPermissionGuard,
} from '~/ai/tools/permission-guard'
import { createAITools } from '~/ai/tools/tools'
import type { AppToolContext } from '~/ai/core/types'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { getMasterAgent } from '~/ai/chat/domain'
import { findAgent } from '~/ai/chat/agents/agent-tree'
import { createFragmentReadTracker } from '~/ai/tools/file-operation'
import {
	createAgentDefinitions,
	filterToolsForAgent,
	type AgentDefinition,
} from '~/ai/chat/agents/registry'
import { MAX_TASK_DEPTH } from '~/ai/chat/prompts'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import { resolveChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import { InMemoryFs } from 'just-bash/browser'
import type NutstorePlugin from '../../..'

type DispatchTaskHandler =
	import('~/ai/tools/task').CreateTaskToolOptions['dispatchTask']

export class ToolExecutor {
	private dispatchTaskHandler: DispatchTaskHandler = () => {
		throw new Error('task handler not set')
	}

	constructor(
		private plugin: NutstorePlugin,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
	) {}

	setDispatchTaskHandler(handler: DispatchTaskHandler) {
		this.dispatchTaskHandler = handler
	}

	getChatModalMountTarget() {
		return resolveChatModalMountTarget(this.state.chatModalHostEl)
	}

	getAgentDefinitions() {
		return createAgentDefinitions({
			fullAccess: Boolean(this.plugin.settings.ai.yolo),
		})
	}

	getAgentDefinition(agentType: string): AgentDefinition {
		const definition = this.getAgentDefinitions().find(
			(candidate) => candidate.id === agentType,
		)
		if (!definition) throw new Error(`Unknown agent type: ${agentType}`)
		return definition
	}

	createToolsForContext(
		session: ChatSession,
		depth: number,
		definition: AgentDefinition,
	) {
		const allowSpawn = depth < MAX_TASK_DEPTH
		const runtime = this.runtimeStates.get(session.id)
		const bashScratch = runtime.bashScratch ?? new InMemoryFs()
		runtime.bashScratch = bashScratch
		const permissionGuard =
			definition.permissionMode === 'readonly'
				? createReadonlyPermissionGuard()
				: definition.permissionMode === 'full'
					? createFullAccessPermissionGuard()
					: createPermissionGuard(
							this.plugin.app,
							{
								has: (signature) =>
									this.runtimeStates
										.getAutoApproveRequests(session.id)
										.has(signature),
								add: (signature) => {
									this.runtimeStates
										.getAutoApproveRequests(session.id)
										.add(signature)
								},
							},
							{
								sessionTitle:
									this.state.sessionIndex.find((item) => item.id === session.id)
										?.title || deriveTitle(session),
								modalMountTarget: this.getChatModalMountTarget(),
							},
						)
		const tools = createAITools(this.plugin.app, {
			allowSpawn,
			bashScratch,
			permissionGuard,
			enableTodoWrite: depth === 0,
			dispatchTask: (params) => this.dispatchTaskHandler(params),
			dispatchableDefinitions: this.getAgentDefinitions(),
		})
		return filterToolsForAgent(tools, definition)
	}

	prepareExecutionContext(context: AppToolContext): AppToolContext {
		const agent =
			findAgent(getMasterAgent(context.session), context.agentId) ??
			getMasterAgent(context.session)
		const readSnapshot = new Set<string>(agent.readVaultPaths ?? [])
		return {
			...context,
			readTracker: createFragmentReadTracker(agent, readSnapshot),
		}
	}
}

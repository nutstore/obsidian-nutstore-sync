import { InMemoryFs, type IFileSystem } from 'just-bash/browser'
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'

import {
	createPermissionGuard,
	createReadonlyPermissionGuard,
	createFullAccessPermissionGuard,
	type PermissionGuard,
} from '~/ai/tools/permission-guard'
import { createAITools } from '~/ai/tools/tools'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { getMasterAgent } from '~/ai/chat/domain'
import { findAgent } from '~/ai/chat/agents/agent-tree'
import {
	createFragmentReadTracker,
	type ReadTracker,
} from '~/ai/tools/file-operation'
import {
	createAgentDefinitions,
	filterToolsForAgent,
	type AgentDefinition,
} from '~/ai/chat/agents/registry'
import { MAX_TASK_DEPTH } from '~/ai/chat/prompts'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import { resolveChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { DispatchTaskFn } from '~/ai/tools/task'
import { MASTER_AGENT_ID } from '~/ai/chat/agents/registry'
import type McpService from '~/services/mcp.service'
import type { NutstoreSettings } from '~/settings'

export interface StableToolsContext {
	app: App
	permissionGuard?: PermissionGuard
	scratch: IFileSystem
	dispatchTask?: DispatchTaskFn
	dispatchableDefinitions?: readonly AgentDefinition[]
}

export class ToolExecutor {
	private dispatchTaskHandler: DispatchTaskFn = () => {
		throw new Error('task handler not set')
	}

	constructor(
		private app: App,
		private getSettings: () => NutstoreSettings['ai'],
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private mcpService: McpService,
	) {}

	setDispatchTaskHandler(handler: DispatchTaskFn) {
		this.dispatchTaskHandler = handler
	}

	getChatModalMountTarget() {
		return resolveChatModalMountTarget(this.state.chatModalHostEl)
	}

	getAgentDefinitions() {
		return createAgentDefinitions({
			fullAccess: Boolean(this.getSettings().yolo),
		})
	}

	getAgentDefinition(agentType: string): AgentDefinition {
		const definition = this.getAgentDefinitions().find(
			(candidate) => candidate.id === agentType,
		)
		if (!definition) throw new Error(`Unknown agent type: ${agentType}`)
		return definition
	}

	async createTools(
		depth: number,
		definition: AgentDefinition,
		session?: ChatSession,
	) {
		const allowSpawn = depth < MAX_TASK_DEPTH
		const tools = createAITools({
			allowSpawn,
			enableTodoWrite: depth === 0,
		})
		if (definition.id === MASTER_AGENT_ID) {
			await this.mcpService.refreshIfChanged()
			Object.assign(
				tools,
				this.mcpService.getToolsForSession(session?.disabledMcpServers),
			)
		}
		return filterToolsForAgent(tools, definition)
	}

	createStableToolsContext(
		session: ChatSession,
		definition: AgentDefinition,
	): StableToolsContext {
		const runtime = this.runtimeStates.get(session.id)
		const bashScratch = runtime.bashScratch ?? new InMemoryFs()
		runtime.bashScratch = bashScratch
		const permissionGuard =
			definition.permissionMode === 'readonly'
				? createReadonlyPermissionGuard()
				: definition.permissionMode === 'full'
					? createFullAccessPermissionGuard()
					: createPermissionGuard(
							this.app,
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
		return {
			app: this.app,
			permissionGuard,
			scratch: bashScratch,
			dispatchTask: (params) => this.dispatchTaskHandler(params),
			dispatchableDefinitions: this.getAgentDefinitions(),
		}
	}

	prepareReadTracker(session: ChatSession, agentId: string): ReadTracker {
		const agent =
			findAgent(getMasterAgent(session), agentId) ?? getMasterAgent(session)
		const readSnapshot = new Set<string>(agent.readVaultPaths ?? [])
		return createFragmentReadTracker(agent, readSnapshot)
	}
}

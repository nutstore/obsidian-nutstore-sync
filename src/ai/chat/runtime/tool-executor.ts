import type { AppOpenFn, AppWorkspaces } from '~/ai/apps/workspaces'
import type { ModuleScope } from '~/modules/lifecycle'
import { guardAppIO } from '~/modules/guard-io'
import { throwIfAborted } from '~/utils/abort'
import type { App } from 'obsidian'
import type { AgentCommunication } from '~/ai/tools/agent-communication'
import type { ChatSession } from '~/ai/chat/domain'

import { findAgent } from '~/ai/chat/agents/agent-tree'
import {
	createAgentDefinitions,
	filterToolsForAgent,
	listDispatchableDefinitions,
	MASTER_AGENT_ID,
	type AgentDefinition,
} from '~/ai/chat/agents/registry'
import { getMasterAgent } from '~/ai/chat/domain'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import { MAX_TASK_DEPTH } from '~/ai/chat/prompts'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import { resolveChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import type { AIModelConfig } from '~/ai/core/types'
import {
	createFragmentReadTracker,
	type ReadTracker,
} from '~/ai/tools/file-operation'
import {
	createFullAccessPermissionGuard,
	createPermissionGuard,
	createReadonlyPermissionGuard,
	type PermissionGuard,
} from '~/ai/tools/permission-guard'
import type { DispatchTaskFn } from '~/ai/tools/task'
import { createAITools } from '~/ai/tools/tools'
import { VaultFileSystemManager } from '~/ai/tools/vault-filesystem'
import type {
	SettingsSnapshotFn,
	SettingsUpdater,
} from '~/ai/tools/tool-context'
import type { MemoryRepository } from '~/ai/memory/repository'
import type McpService from '~/services/mcp.service'
import type { NutstoreSettings } from '~/settings'

export interface StableToolsContext {
	app: App
	fileSystemManager: VaultFileSystemManager
	permissionGuard?: PermissionGuard
	communication?: AgentCommunication
	dispatchTask?: DispatchTaskFn
	dispatchableDefinitions?: readonly AgentDefinition[]
	getSettingsSnapshot?: SettingsSnapshotFn
	updateSettings?: SettingsUpdater
	memory: MemoryRepository
}

export class ToolExecutor {
	private readonly fileSystemManager: VaultFileSystemManager
	private dispatchTaskHandler: DispatchTaskFn = () => {
		throw new Error('task handler not set')
	}
	private appOpenHandler: AppOpenFn = async () => {
		throw new Error('App open handler not set')
	}

	constructor(
		private app: App,
		private getSettings: () => NutstoreSettings['ai'],
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private mcpService: McpService,
		private settingsIo: {
			getSettingsSnapshot: SettingsSnapshotFn
			updateSettings: SettingsUpdater
		},
		private memory: MemoryRepository,
		private scope?: ModuleScope,
		private workspaces?: {
			service: AppWorkspaces
			persist: (session: ChatSession) => Promise<void>
		},
	) {
		this.fileSystemManager = new VaultFileSystemManager(app)
	}

	private communication?: AgentCommunication

	setAgentCommunication(communication: AgentCommunication) {
		this.communication = communication
	}

	getFileSystemManager() {
		return this.fileSystemManager
	}

	setDispatchTaskHandler(handler: DispatchTaskFn) {
		this.dispatchTaskHandler = handler
	}

	setAppOpenHandler(handler: AppOpenFn) {
		this.appOpenHandler = handler
	}

	getChatModalMountTarget() {
		return resolveChatModalMountTarget(this.state.chatModalHostEl)
	}

	private getAgentDefinitionSettings() {
		const settings = this.getSettings()
		return {
			fullAccess: Boolean(settings.yolo),
			subagents: settings.subagents,
			memory: settings.memory,
		}
	}

	getAgentDefinitions() {
		return createAgentDefinitions(this.getAgentDefinitionSettings())
	}

	getSubagentModelSelection(agentType: string) {
		const selection =
			agentType === 'explorer'
				? this.getSettings().subagents?.[agentType]
				: undefined
		return selection?.model ? { ...selection.model } : undefined
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
		model?: AIModelConfig,
	) {
		this.scope?.check()
		const allowSpawn = depth < MAX_TASK_DEPTH
		const tools = createAITools({
			allowSpawn,
			enableTodoWrite: depth === 0,
			enableViewImage: model?.modalities.input.includes('image') ?? false,
		})
		if (definition.id === MASTER_AGENT_ID) {
			if (session) {
				Object.assign(
					tools,
					this.mcpService.getToolsForSession(
						session.id,
						session.disabledMcpServers,
					),
				)
			}
		}
		return filterToolsForAgent(tools, definition)
	}

	createStableToolsContext(
		session: ChatSession,
		definition: AgentDefinition,
		signal?: AbortSignal,
	): StableToolsContext {
		const check = () => {
			this.scope?.check()
			throwIfAborted(signal)
		}
		check()
		const effectiveSignal = signal ?? this.scope?.signal
		const app = guardAppIO(this.app, check)
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
								signal: effectiveSignal,
							},
						)
		const appWorkspaceBinding =
			definition.id === MASTER_AGENT_ID && this.workspaces
				? this.workspaces.service.createBinding(
						session,
						() => this.workspaces!.persist(session),
						effectiveSignal,
					)
				: undefined
		return {
			app,
			fileSystemManager: this.fileSystemManager.withDefaults({
				appLifecycle: this.workspaces?.service,
				appWorkspaceBinding,
				openApp: async (appId) => {
					check()
					const opened = await this.appOpenHandler(appId)
					check()
					return opened
				},
				readonlyApps:
					definition.permissionMode === 'readonly' ||
					definition.id !== MASTER_AGENT_ID,
			}),
			permissionGuard: async (request) => {
				check()
				await permissionGuard(request)
				check()
			},
			communication: this.communication,
			dispatchTask: (params, origin) =>
				this.dispatchTaskHandler(params, origin),
			dispatchableDefinitions: listDispatchableDefinitions(
				this.getAgentDefinitionSettings(),
			),
			getSettingsSnapshot: this.settingsIo.getSettingsSnapshot,
			updateSettings: this.settingsIo.updateSettings,
			memory: this.memory,
		}
	}

	prepareReadTracker(session: ChatSession, agentId: string): ReadTracker {
		const agent =
			findAgent(getMasterAgent(session), agentId) ?? getMasterAgent(session)
		const readSnapshot = new Set<string>(agent.readVaultPaths ?? [])
		return createFragmentReadTracker(agent, readSnapshot)
	}
}

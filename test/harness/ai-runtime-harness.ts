import type { App } from 'obsidian'
import { vi } from 'vitest'
import { createModelConfig, createProviderConfig } from '~/ai/catalog/config'
import { getAgentDefinition } from '~/ai/chat/agents/registry'
import { getSessionSubagents, type ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import {
	consumePendingInputs,
	createEmptyMasterAgent,
} from '~/ai/chat/messages/ui-message'
import type {
	AgentRunner,
	AgentTurnResult,
} from '~/ai/chat/runtime/agent-runner'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import { ContextCompactionCoordinator } from '~/ai/chat/runtime/context-compaction-coordinator'
import type { TaskOrigin } from '~/ai/chat/runtime/master-turn-scheduler'
import { Selection } from '~/ai/chat/runtime/selection'
import { TaskManager } from '~/ai/chat/runtime/task-manager'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import type { ToolCallRepeatState } from '~/ai/core/tool-call-repeat'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import type { AgentAddress } from '~/ai/tools/agent-communication'
import { DEFAULT_SETTINGS, type NutstoreSettings } from '~/settings'
import { createDeferred, type Deferred } from './async-scheduler'
import { MemoryVault } from './memory-vault'

export interface RecordedMasterWake {
	sessionId: string
	input: AppUIMessage
	origin: TaskOrigin
}

export interface AgentTurnInvocation {
	session: ChatSession
	agent: ChatAgentState
	continuation?: ToolCallRepeatState
	abortSignal?: AbortSignal
	deferred: Deferred<AgentTurnResult>
}

export interface AIRuntimeHarnessOptions {
	sessionId?: string
	model?: { providerId: string; modelId: string }
	providers?: Record<string, AIProviderConfig>
	enableExplorer?: boolean
	subagentModelSelection?: () =>
		{ providerId: string; modelId: string } | undefined
	onPersistSession?: (
		session: ChatSession,
		isCurrent?: () => boolean,
	) => Promise<void>
	onRunTurn?: (invocation: {
		session: ChatSession
		agent: ChatAgentState
		continuation?: ToolCallRepeatState
		abortSignal?: AbortSignal
	}) => Promise<AgentTurnResult>
	onMasterWake?: (wake: RecordedMasterWake) => boolean
}

export function createTestProvider(
	id: string,
	modelId: string,
	limit = { context: 100_000, output: 10_000 },
): AIProviderConfig {
	return createProviderConfig({
		id,
		name: `Provider ${id} 🌿`,
		api: 'https://neutral.example.test/v1',
		apiKey: 'neutral-key',
		models: {
			[modelId]: createModelConfig({
				id: modelId,
				name: `Model ${modelId} 🌿`,
				limit,
			}),
		},
	})
}

/**
 * Single typed in-memory rig shared by `TaskManager` unit tests,
 * `agent-communication.test.ts`, and `ai-runtime.sim.test.ts`.
 */
export function createAIRuntimeHarness(options: AIRuntimeHarnessOptions = {}) {
	const vault = new MemoryVault({ name: 'AIRuntimeVault' })
	const app = vault.app as unknown as App
	const defaultProvider = createTestProvider(
		'neutral-provider',
		'neutral-model',
		{ context: 128_000, output: 8_192 },
	)
	const providers = options.providers ?? {
		[defaultProvider.id]: defaultProvider,
	}
	const sessionModel = options.model ?? {
		providerId: defaultProvider.id,
		modelId: 'neutral-model',
	}
	const enableExplorer = options.enableExplorer ?? true

	const aiSettings: NutstoreSettings['ai'] = {
		...DEFAULT_SETTINGS.ai,
		providers,
		defaultModel: sessionModel,
		subagents: {
			...DEFAULT_SETTINGS.ai.subagents,
			explorer: {
				...DEFAULT_SETTINGS.ai.subagents?.explorer,
				enabled: enableExplorer,
			},
		},
	}

	const master = createEmptyMasterAgent(1)
	const session: ChatSession = {
		schemaVersion: 2,
		id: options.sessionId ?? 'session',
		createdAt: 1,
		updatedAt: 1,
		model: sessionModel,
		subagents: { master },
	}

	const state = new ChatState()
	state.loadedSessions.set(session.id, session)
	state.activeSessionId = session.id

	let notifyCount = 0
	const notify = vi.fn(() => {
		notifyCount += 1
	})

	const persistedSnapshots: ChatSession[] = []
	const persistSession = vi.fn(
		async (target: ChatSession, isCurrent?: () => boolean) => {
			if (options.onPersistSession) {
				await options.onPersistSession(target, isCurrent)
				return
			}
			if (isCurrent && !isCurrent()) return
			persistedSnapshots.push(structuredClone(target))
		},
	)
	const store = {
		persistSession,
		persistMetaAndIndex: vi.fn(async () => undefined),
		upsertSessionIndexItem: vi.fn(),
	} as unknown as SessionStore

	const selection = new Selection(
		() => aiSettings,
		state,
		notify,
		persistSession,
	)
	const factory = new MessageFactory(app, notify)
	const coordinator = new ContextCompactionCoordinator(store, factory)

	const toolExecutor = {
		getAgentDefinition: (type: string) => {
			const definition = getAgentDefinition(type, {
				fullAccess: false,
				subagents: { explorer: { enabled: enableExplorer } },
			})
			if (!definition) throw new Error(`Unknown agent type: ${type}`)
			return definition
		},
		getSubagentModelSelection:
			options.subagentModelSelection ?? (() => undefined),
	} as unknown as ToolExecutor

	const activeTurns = new Map<string, AgentTurnInvocation[]>()
	const turns = new Map<string, Deferred<AgentTurnResult>>()
	const allTurns: AgentTurnInvocation[] = []

	const runTurn = vi.fn(
		(params: {
			session: ChatSession
			agent: ChatAgentState
			continuation?: ToolCallRepeatState
			abortSignal?: AbortSignal
		}) => {
			consumePendingInputs(params.agent)
			if (options.onRunTurn) return options.onRunTurn(params)
			const deferred = createDeferred<AgentTurnResult>()
			const invocation: AgentTurnInvocation = { ...params, deferred }
			const list = activeTurns.get(params.agent.id) ?? []
			list.push(invocation)
			activeTurns.set(params.agent.id, list)
			turns.set(params.agent.id, deferred)
			allTurns.push(invocation)
			return deferred.promise
		},
	)

	const agentRunner = {
		runTurn,
		resolveSummaryContext: vi.fn(async () => ({})),
	} as unknown as AgentRunner

	const manager = new TaskManager(
		app,
		async () => {},
		state,
		selection,
		store,
		notify,
		toolExecutor,
		factory,
		agentRunner,
		coordinator,
	)

	const masterWakes: RecordedMasterWake[] = []
	const masterHandler = vi.fn(
		(sid: string, input: AppUIMessage, origin: TaskOrigin) => {
			const record = { sessionId: sid, input, origin }
			masterWakes.push(record)
			return options.onMasterWake ? options.onMasterWake(record) : true
		},
	)
	manager.setMasterAgentInputHandler(masterHandler)

	const controller = new AbortController()
	const origin: TaskOrigin = { turnId: 'turn-1', signal: controller.signal }

	const address = (
		agentId = 'master',
		customOrigin: TaskOrigin = origin,
	): AgentAddress => ({
		sessionId: session.id,
		agentId,
		origin: customOrigin,
	})

	const spawn = async (
		prompt = '归纳主题 / Summarize themes 🌿',
		callerAgentId = 'master',
		customOrigin: TaskOrigin = origin,
	): Promise<ChatAgentState> => {
		const { taskId } = await manager.dispatchTask(
			{
				sessionId: session.id,
				callerAgentId,
				subagentType: 'explorer',
				prompt,
			},
			customOrigin,
		)
		const found = getSessionSubagents(session).find((a) => a.id === taskId)
		if (!found) throw new Error(`Spawned agent not found: ${taskId}`)
		return found
	}

	return {
		app,
		vault,
		session,
		master,
		state,
		provider: defaultProvider,
		model: defaultProvider.models['neutral-model'] as AIModelConfig,
		store,
		persistSession,
		coordinator,
		runTurn,
		manager,
		controller,
		origin,
		address,
		spawn,
		activeTurns,
		turns,
		allTurns,
		getLatestTurn: (agentId: string) => activeTurns.get(agentId)?.at(-1),
		masterWakes,
		masterHandler,
		persistedSnapshots,
		get notifyCount() {
			return notifyCount
		},
	}
}

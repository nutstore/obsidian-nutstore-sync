import { generateText, type ModelMessage, type ToolSet } from 'ai'
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import { findLatestTodos, resolveUsedContextTokens } from '~/ai/chat/domain'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import {
	selectContextTimeline,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import { buildAgentSystemPrompt, COMPRESSION_PROMPT } from '~/ai/chat/prompts'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import {
	resolveModelOutputLimit,
	resolveSummaryOutputTokenBudget,
} from '~/ai/core/inference'
import {
	prepareMessagesForModel,
	resolveLanguageModel,
} from '~/ai/core/runtime'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'

const FALLBACK_CONTEXT_WINDOW = 256 * 1024
const MIN_CONTEXT_SAFETY_MARGIN = 4096
const CONTEXT_SAFETY_MARGIN_RATIO = 0.05
const MIN_COMPACTION_LEAD_TOKENS = 4096
const COMPACTION_LEAD_CONTEXT_RATIO = 0.05
const RECENT_TURNS_CONTEXT_RATIO = 0.05
const MIN_RECENT_TURNS_TOKEN_BUDGET = 2048
const MAX_RECENT_TURNS_TOKEN_BUDGET = 4096 * 4
const MAX_RECENT_TURNS = 8
const ESTIMATED_UTF8_BYTES_PER_TOKEN = 3

export type SummaryToolSet = ToolSet

/**
 * A summary replays prior tool calls for transcript conversion only.  Its
 * tools must therefore retain schemas while dropping every executable entry
 * point, including when a manual caller supplies an unfiltered tool set.
 */
function createSummaryToolSchemas(
	tools: ToolSet | undefined,
): SummaryToolSet | undefined {
	if (!tools) return undefined
	return Object.fromEntries(
		Object.entries(tools).map(([name, tool]) => {
			const { execute: _execute, ...schema } = tool
			return [name, schema]
		}),
	)
}

export type ContextPressure = 'normal' | 'soft' | 'hard'

/** Immutable compression source selected at the trigger point. */
export interface ContextCompressionPlan {
	summarizedThroughMessageId: string
	/** Exact source prefix identity, used to reject stale background results. */
	sourceMessageIds: string[]
	/** Exact retained suffix identity, used if the anchor is later deleted. */
	retainedMessageIds: string[]
	messages: AppUIMessage[]
}

export type ContextCompressionResult =
	| 'committed'
	| 'unavailable'
	| 'cancelled'
	| 'failed'
	| 'stale'

export class ContextCompressionFailedError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ContextCompressionFailedError'
	}
}

interface GenerateContextCompressionOptions {
	provider: AIProviderConfig
	model: AIModelConfig
	session: ChatSession
	plan: ContextCompressionPlan
	/** System prompt identical to the main loop's, so the summarizer replays the warm prefix. */
	system?: string
	/** Per-agent tool schemas, retained only to interpret the transcript. */
	tools?: SummaryToolSet
	/** Builds the source transcript exactly like the agent loop (user-context aware). */
	buildMessages?: (
		messages: AppUIMessage[],
		tools: ToolSet,
	) => Promise<ModelMessage[]>
	isCancelled?: () => boolean
	abortSignal?: AbortSignal
}

interface CommitContextCompressionOptions {
	session: ChatSession
	agent: ChatAgentState
	plan: ContextCompressionPlan
	summary: string
	store: SessionStore
	messageFactory: MessageFactory
}

interface CompressContextRunnerOptions extends Omit<
	GenerateContextCompressionOptions,
	'plan'
> {
	agent: ChatAgentState
	store: SessionStore
	messageFactory: MessageFactory
}

export function resolveContextWindow(model?: AIModelConfig) {
	const configuredLimit = model?.limit?.context
	return configuredLimit && configuredLimit > 0
		? configuredLimit
		: FALLBACK_CONTEXT_WINDOW
}

function resolveModelInputLimit(model: AIModelConfig | undefined) {
	const configuredLimit = model?.limit?.input
	return configuredLimit && configuredLimit > 0 ? configuredLimit : undefined
}

function resolveRecentTurnsTokenBudget(contextWindow: number) {
	return Math.min(
		MAX_RECENT_TURNS_TOKEN_BUDGET,
		Math.max(
			MIN_RECENT_TURNS_TOKEN_BUDGET,
			contextWindow * RECENT_TURNS_CONTEXT_RATIO,
		),
	)
}

function resolveSafetyMargin(contextWindow: number) {
	return Math.max(
		MIN_CONTEXT_SAFETY_MARGIN,
		Math.floor(contextWindow * CONTEXT_SAFETY_MARGIN_RATIO),
	)
}

function resolveCompactionLead(contextWindow: number) {
	return Math.max(
		MIN_COMPACTION_LEAD_TOKENS,
		Math.floor(contextWindow * COMPACTION_LEAD_CONTEXT_RATIO),
	)
}

function isContextCheckpoint(message: AppUIMessage) {
	return message.parts.some((part) => part.type === 'data-context-checkpoint')
}

function estimateSerializedTokens(value: unknown) {
	const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
	return Math.ceil(bytes / ESTIMATED_UTF8_BYTES_PER_TOKEN)
}

/** Stable local estimate used only to verify that compaction made progress. */
export function estimateContextTokens(agent: ChatAgentState) {
	return estimateSerializedTokens(selectContextTimeline(agent.timeline))
}

export async function findRecentTurnStartIndex(
	messages: AppUIMessage[],
	tokenBudget: number,
) {
	const turnStarts = messages.flatMap((message, index) =>
		message.role === 'user' && !isContextCheckpoint(message) ? [index] : [],
	)
	if (turnStarts.length === 0) {
		const firstConversationMessage = messages.findIndex(
			(message) => !isContextCheckpoint(message),
		)
		return firstConversationMessage < 0
			? messages.length
			: firstConversationMessage
	}

	let firstPreservedTurn = turnStarts.at(-1)!
	let preservedTokens = 0
	let preservedTurns = 0
	for (let turn = turnStarts.length - 1; turn >= 0; turn -= 1) {
		const start = turnStarts[turn]
		const end = turnStarts[turn + 1] ?? messages.length
		const modelMessages = await uiMessagesToModelMessages(
			messages.slice(start, end),
		)
		const turnTokens = estimateSerializedTokens(modelMessages)
		if (
			preservedTurns > 0 &&
			(preservedTurns >= MAX_RECENT_TURNS ||
				preservedTokens + turnTokens > tokenBudget)
		) {
			break
		}
		firstPreservedTurn = start
		preservedTokens += turnTokens
		preservedTurns += 1
	}
	return firstPreservedTurn
}

function resolveLatestContextUsage(agent: ChatAgentState) {
	const contextTimeline = selectContextTimeline(agent.timeline)
	const checkpointCreatedAt = contextTimeline[0]?.parts.some(
		(part) => part.type === 'data-context-checkpoint',
	)
		? contextTimeline[0].metadata?.createdAt
		: undefined
	return [...contextTimeline]
		.reverse()
		.find(
			(message) =>
				message.role === 'assistant' &&
				message.metadata?.llm?.usage &&
				(checkpointCreatedAt === undefined ||
					(message.metadata.createdAt ?? 0) > checkpointCreatedAt),
		)?.metadata?.llm?.usage
}

export function resolveContextPressure(
	agent: ChatAgentState,
	model?: AIModelConfig,
): ContextPressure {
	const usedTokens = resolveUsedContextTokens(resolveLatestContextUsage(agent))
	if (usedTokens <= 0) return 'normal'

	const contextWindow = resolveContextWindow(model)
	const outputBudget = resolveModelOutputLimit(model) ?? 0
	const modelInputLimit = resolveModelInputLimit(model)
	const availableInputTokens = Math.max(0, contextWindow - outputBudget)
	const inputCapacity = Math.min(
		modelInputLimit ?? availableInputTokens,
		availableInputTokens,
	)
	const hardLimit = Math.max(
		0,
		inputCapacity - resolveSafetyMargin(contextWindow),
	)
	const softLimit = Math.max(
		0,
		hardLimit - resolveCompactionLead(contextWindow),
	)
	if (usedTokens >= hardLimit) return 'hard'
	return usedTokens >= softLimit ? 'soft' : 'normal'
}

/** True only when continuing without a committed summary risks the next call. */
export function shouldAutoCompressAgent(
	agent: ChatAgentState,
	model?: AIModelConfig,
) {
	return resolveContextPressure(agent, model) === 'hard'
}

/** True when background compaction should start before reaching the hard limit. */
export function shouldStartContextCompaction(
	agent: ChatAgentState,
	model?: AIModelConfig,
) {
	return resolveContextPressure(agent, model) !== 'normal'
}

/**
 * Select a completed prefix to summarize. The selected message ids are stable
 * even if new turns arrive while the remote summarizer is running.
 */
export async function createContextCompressionPlan(
	agent: ChatAgentState,
	model: AIModelConfig,
	options: { allowFullContext?: boolean } = {},
): Promise<ContextCompressionPlan | undefined> {
	const contextTimeline = selectContextTimeline(agent.timeline)
	if (contextTimeline.length === 0) return undefined
	const preservedTurnIndex = await findRecentTurnStartIndex(
		contextTimeline,
		resolveRecentTurnsTokenBudget(resolveContextWindow(model)),
	)
	const summaryEndIndex =
		preservedTurnIndex > 0
			? preservedTurnIndex
			: options.allowFullContext
				? contextTimeline.length
				: 0
	if (summaryEndIndex === 0) return undefined

	const messages = contextTimeline.slice(0, summaryEndIndex)
	const summarizedThroughMessageId = messages.at(-1)?.id
	if (!summarizedThroughMessageId) return undefined
	return {
		summarizedThroughMessageId,
		sourceMessageIds: messages.map((message) => message.id),
		retainedMessageIds: contextTimeline
			.slice(summaryEndIndex)
			.map((message) => message.id),
		messages,
	}
}

/**
 * Resolve the system prompt + per-agent tools both manual and background
 * callers reuse so the summarizer request retains the main loop's prefix.
 */
export async function resolveSummaryContext(
	agent: ChatAgentState,
	session: ChatSession,
	model: AIModelConfig,
	toolExecutor: ToolExecutor,
	app: App,
): Promise<{
	system?: string
	tools?: SummaryToolSet
}> {
	try {
		const definition = toolExecutor.getAgentDefinition(agent.type)
		const [system, tools] = await Promise.all([
			buildAgentSystemPrompt(app, agent.type, session.systemPrompt),
			toolExecutor.createTools(0, definition, session, model),
		])
		return {
			system,
			tools: createSummaryToolSchemas(tools),
		}
	} catch {
		return {}
	}
}

/** Generate a summary from a frozen source plan without mutating the session. */
export async function generateContextCompression(
	options: GenerateContextCompressionOptions,
): Promise<string | undefined> {
	const tools = createSummaryToolSchemas(options.tools)
	const { model: languageModel } = resolveLanguageModel(
		options.provider,
		options.model.id,
	)
	const messageSequence =
		options.buildMessages && tools
			? await options.buildMessages(options.plan.messages, tools)
			: await uiMessagesToModelMessages(options.plan.messages, tools)
	const preparedMessages = prepareMessagesForModel(
		options.provider,
		options.model.id,
		messageSequence,
	)
	// This instruction belongs only to the summarizer branch, never the live timeline.
	const response = await generateText<SummaryToolSet>({
		model: languageModel,
		...(options.system === undefined ? {} : { system: options.system }),
		...(tools === undefined ? {} : { tools }),
		toolChoice: 'none',
		messages: [
			...preparedMessages,
			{
				role: 'user',
				content: [{ type: 'text', text: COMPRESSION_PROMPT }],
			},
		],
		abortSignal: options.abortSignal,
		maxOutputTokens: resolveSummaryOutputTokenBudget(options.model),
	})
	if (options.isCancelled?.()) return undefined
	const summary = response.text.trim()
	return summary || undefined
}

export function isContextCompressionPlanCurrent(
	plan: ContextCompressionPlan,
	agent: ChatAgentState,
) {
	const currentPrefix = selectContextTimeline(agent.timeline).slice(
		0,
		plan.sourceMessageIds.length,
	)
	return (
		currentPrefix.length === plan.sourceMessageIds.length &&
		currentPrefix.every(
			(message, index) => message.id === plan.sourceMessageIds[index],
		)
	)
}

/** Commit a ready summary at a runtime safe point. */
export async function commitContextCompression({
	session,
	agent,
	plan,
	summary,
	store,
	messageFactory,
}: CommitContextCompressionOptions) {
	if (!isContextCompressionPlanCurrent(plan, agent)) return false
	const todos = findLatestTodos(session)
	const todoLines = todos.map(
		(todo) => `- [${todo.status}] ${todo.content} (${todo.priority})`,
	)
	const finalSummary =
		todos.length > 0
			? [
					summary,
					'',
					'<CurrentTodoList>',
					...todoLines,
					'</CurrentTodoList>',
				].join('\n')
			: summary
	messageFactory.appendContextBoundary(session, agent, {
		mode: 'summary',
		summary: finalSummary,
		summarizedThroughMessageId: plan.summarizedThroughMessageId,
		retainedMessageIds: plan.retainedMessageIds,
	})
	store.upsertSessionIndexItem(session, deriveTitle(session))
	await store.persistSession(session)
	await store.persistMetaAndIndex()
	return true
}

/** Manual compression keeps its synchronous UX but uses the same plan/commit path. */
export async function runContextCompression({
	agent,
	store,
	messageFactory,
	...options
}: CompressContextRunnerOptions): Promise<ContextCompressionResult> {
	const plan = await createContextCompressionPlan(agent, options.model, {
		allowFullContext: true,
	})
	if (!plan) return 'unavailable'
	if (options.isCancelled?.()) return 'cancelled'
	const summary = await generateContextCompression({ ...options, plan })
	if (options.isCancelled?.()) return 'cancelled'
	if (!summary) return 'failed'
	const committed = await commitContextCompression({
		session: options.session,
		agent,
		plan,
		summary,
		store,
		messageFactory,
	})
	return committed ? 'committed' : 'stale'
}

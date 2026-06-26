import {
	cloneMessageRecord,
	resolveUsedContextTokens,
	type ChatFragment,
} from '~/ai/chat/domain'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import {
	deriveTitle,
	messageToText,
	toTextParts,
} from '~/ai/chat/messages/message-utils'
import { COMPRESSION_PROMPT } from '~/ai/chat/prompts'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { ChatMessageRecord } from '~/ai/chat/types'
import { generateAssistantTurn } from '~/ai/core/runtime'
import type {
	AIModelConfig,
	AIProviderConfig,
	AISession,
} from '~/ai/core/types'

const FALLBACK_CONTEXT_WINDOW = 256 * 1024
const MIN_AUTO_COMPRESSION_THRESHOLD = 4096 * 4
const AUTO_COMPRESSION_CONTEXT_RATIO = 0.1

function collectTrailingUserRecords(fragment: ChatFragment) {
	const trailingUserRecords: ChatMessageRecord[] = []
	for (let index = fragment.messages.length - 1; index >= 0; index -= 1) {
		const record = fragment.messages[index]
		if (record.message.role !== 'user') {
			break
		}
		trailingUserRecords.push(cloneMessageRecord(record))
	}
	return trailingUserRecords.reverse()
}

export function resolveContextWindow(model?: AIModelConfig) {
	const configuredLimit = model?.limit?.context
	return configuredLimit && configuredLimit > 0
		? configuredLimit
		: FALLBACK_CONTEXT_WINDOW
}

export function resolveAutoCompressionThreshold(contextWindow: number) {
	return Math.max(
		contextWindow * AUTO_COMPRESSION_CONTEXT_RATIO,
		MIN_AUTO_COMPRESSION_THRESHOLD,
	)
}

export function shouldAutoCompressFragment(
	fragment: ChatFragment,
	model?: AIModelConfig,
) {
	const latestUsage = [...fragment.messages]
		.reverse()
		.find((item) => item.message.role === 'assistant' && item.meta?.usage)
		?.meta?.usage
	const usedTokens = resolveUsedContextTokens(latestUsage)
	if (usedTokens <= 0) {
		return false
	}

	const contextWindow = resolveContextWindow(model)
	const remainingContext = contextWindow - usedTokens
	return remainingContext < resolveAutoCompressionThreshold(contextWindow)
}

export interface CompressContextRunnerOptions {
	provider: AIProviderConfig
	model: AIModelConfig
	session: AISession
	sourceFragment: ChatFragment
	runtimeStates: RuntimeStates
	store: SessionStore
	messageFactory: MessageFactory
	isSessionDeleted?: () => boolean
	abortSignal?: AbortSignal
}

export async function runContextCompression({
	provider,
	model,
	session,
	sourceFragment,
	runtimeStates,
	store,
	messageFactory,
	isSessionDeleted,
	abortSignal,
}: CompressContextRunnerOptions) {
	if (sourceFragment.messages.length === 0) {
		return
	}

	const response = await generateAssistantTurn({
		provider,
		model: model.id,
		messages: [
			...sourceFragment.messages.map((item) => item.message),
			{
				role: 'user',
				content: toTextParts(COMPRESSION_PROMPT),
			},
		],
		tools: [],
		abortSignal,
		...session.inferenceParams,
	})

	const runtime = runtimeStates.get(session.id)
	if (runtime.stopRequested || isSessionDeleted?.()) {
		return
	}

	const summary = messageToText(response.message).trim() || COMPRESSION_PROMPT
	const trailingUserRecords = collectTrailingUserRecords(sourceFragment)
	const targetFragment = messageFactory.createFragment(session)
	targetFragment.summary = summary
	messageFactory.appendUserMessage(targetFragment, summary, session)
	if (trailingUserRecords.length > 0) {
		targetFragment.messages.push(...trailingUserRecords)
		targetFragment.updatedAt = Date.now()
		session.updatedAt = targetFragment.updatedAt
	}
	store.upsertSessionIndexItem(session, deriveTitle(session))
	await store.persistSession(session)
	await store.persistMetaAndIndex()
}

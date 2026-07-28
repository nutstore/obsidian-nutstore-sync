import type { AgentDefinition } from '~/ai/chat/agents/registry'
import { MASTER_AGENT_ID } from '~/ai/chat/agents/registry'

export const MAX_TASK_DEPTH = 2
export const MAX_CONCURRENT_TASKS_PER_SESSION = 3
export const MAX_INLINE_FILE_BYTES = 20 * 1024
export const CHAT_META_KEY = 'chat_meta'
export const CHAT_INDEX_KEY = 'chat_index'

export const COMPRESSION_PROMPT = [
	'Summarize the conversation above for continuation in a fresh context.',
	'Return a compact but information-dense handoff covering:',
	'1. Confirmed facts and file paths.',
	'2. Decisions already made.',
	'3. Constraints, caveats, and user preferences.',
	'4. Unfinished work and the next concrete step.',
	'5. Any tool results that remain relevant.',
	'Write the summary as a user message that can be pasted into a new chat segment.',
].join(' ')

function createVaultToolGuidance() {
	return [
		'For ambiguous user requests, you may broaden exploration when needed to improve answer quality.',
		'Base answers on evidence from tool results, and cite key file paths or outputs.',
		'Avoid unbounded exploration, but do not stop when evidence is still weak or conflicting.',
		'Stop when evidence is sufficient for a grounded answer, or when further tool use is clearly repetitive.',
	].join(' ')
}

function createTodoWriteGuidance() {
	return [
		'Use todowrite to create and maintain a structured todo list when the work involves more than three steps, needs planning, or the user explicitly asks for task tracking.',
		'Do not use todowrite for single-step tasks, pure information questions, or work that can be completed with one command.',
		'Todo statuses are pending, in_progress, completed, and cancelled. Priorities are high, medium, and low.',
		'Update todos as work progresses: keep exactly one todo in_progress when possible, mark items completed immediately after completion, and do not batch-complete todos at the end.',
	].join(' ')
}

export function createSystemPromptForAgent(
	definition: AgentDefinition,
	sessionSystemPrompt?: string,
	vaultInstructions?: string,
) {
	const wrappedVaultInstructions = vaultInstructions?.trim()
		? `<vault-instructions>\n${vaultInstructions.trim()}\n</vault-instructions>`
		: undefined

	if (definition.id === MASTER_AGENT_ID) {
		return [
			sessionSystemPrompt,
			definition.systemPrompt,
			createVaultToolGuidance(),
			createTodoWriteGuidance(),
			wrappedVaultInstructions,
		]
			.filter(Boolean)
			.join('\n\n')
	}

	return [
		definition.systemPrompt,
		createVaultToolGuidance(),
		'When you finish, return a concise final answer. If the task fails, explain the failure clearly.',
	]
		.filter(Boolean)
		.join('\n\n')
}

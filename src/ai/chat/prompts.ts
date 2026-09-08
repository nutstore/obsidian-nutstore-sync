import type { App } from 'obsidian'
import type { AgentDefinition } from '~/ai/chat/agents/registry'
import {
	getAgentDefinition,
	MASTER_AGENT_ID,
	type AgentDefinitionSettings,
} from '~/ai/chat/agents/registry'
import { createVirtualFilesystemGuidance } from '~/ai/tools/bash/filesystem-guidance'

export const MAX_TASK_DEPTH = 2
export const MAX_CONCURRENT_TASKS_PER_SESSION = 3
export const MAX_INLINE_FILE_BYTES = 20 * 1024
export const CHAT_META_KEY = 'chat_meta'
export const CHAT_INDEX_KEY = 'chat_index'

/**
 * The compression directive, delivered as the FINAL user message after the
 * replayed conversation (never as a separate summarizer system prompt), so the
 * auxiliary call stays a genuine prefix of the last routed request and keeps
 * reusing the provider's warm prefix cache.
 *
 * Structure is tailored to an Obsidian note-taking assistant rather than a
 * coding agent: vault-relative paths, vault conventions, language-neutral.
 */
export const COMPRESSION_PROMPT = [
	'You are now acting as the compression engine for an Obsidian note-taking assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
	'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
	'',
	'## User Goals',
	"- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
	'',
	'## Vault Context',
	'- [vault structure, folders, tags, naming and linking conventions, and any skills in use]',
	'',
	'## Vault Files Touched',
	'- [exact vault-relative path (for example notes/idea.md): why it matters, key changes or snippets]',
	'',
	'## Issues and Resolutions',
	'- [problems or ambiguities encountered and how they were resolved, plus related user feedback]',
	'',
	'## Pending Requests',
	'- [explicitly requested work not yet completed]',
	'',
	'## Current Work',
	'- [precisely what was in progress at this checkpoint]',
	'',
	'## Next Step',
	'- [the single next action, directly in line with the most recent request, or "(none)"]',
	'',
	'## Critical Context',
	'- [decisions and their rationale, constraints, user preferences, open questions, and data needed to continue]',
	'',
	'Rules:',
	'- Write concise prose in the same language as the conversation. Use vault-relative paths for vault files, and preserve exact note names, tags, links, error strings, identifiers, and numeric values.',
	'- Treat hidden dot-folders, including plugin data and the Obsidian config folder, as internal files. Do not include their paths or contents in the checkpoint unless the user explicitly asked about them.',
	'- Capture user feedback and explicit instructions faithfully, especially corrections.',
	'- Do NOT mention this summarization request or that the context was compacted.',
	'- Output only the checkpoint text: do not call any tool or take any other action.',
	'- If the conversation already contains a <ConversationSummary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n')

/**
 * Framing that marks the replacement checkpoint as established background in
 * the derived transcript, so the next turn builds on it without restating it.
 */
export const CHECKPOINT_PREAMBLE =
	'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'

async function readVaultInstructions(app: App): Promise<string | undefined> {
	try {
		const content = await app.vault.adapter.read('AGENTS.md')
		return content.trim() || undefined
	} catch {
		return undefined
	}
}

/**
 * Build the exact system prompt the agent loop uses for a given agent type.
 * Single source of truth for both the main loop and the compression call, so
 * the summarizer request replays the same system prompt byte-for-byte and the
 * provider's warm prefix cache stays reusable.
 */
export async function buildAgentSystemPrompt(
	app: App,
	agentType: string,
	sessionSystemPrompt?: string,
	settings?: AgentDefinitionSettings,
): Promise<string> {
	const definition = getAgentDefinition(agentType, settings)
	if (!definition) throw new Error(`Unknown agent type: ${agentType}`)
	const vaultInstructions = await readVaultInstructions(app)
	return createSystemPromptForAgent(
		definition,
		sessionSystemPrompt,
		vaultInstructions,
	)
}

function createVaultToolGuidance() {
	return [
		'Use tools only when they are needed to answer or act.',
		'Start with the smallest relevant scope and broaden only when evidence is insufficient.',
		'Base answers on tool results, cite key file paths or outputs, and stop when evidence is sufficient.',
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
			createVirtualFilesystemGuidance(),
			createVaultToolGuidance(),
			createTodoWriteGuidance(),
			wrappedVaultInstructions,
		]
			.filter(Boolean)
			.join('\n\n')
	}

	return [
		definition.systemPrompt,
		createVirtualFilesystemGuidance(),
		createVaultToolGuidance(),
		'When you finish, return a concise final answer. If the task fails, explain the failure clearly.',
	]
		.filter(Boolean)
		.join('\n\n')
}

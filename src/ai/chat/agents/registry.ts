import type { ToolSet } from 'ai'
import { agentCommunicationTools } from '~/ai/tools/agent-communication'
import { isMcpToolName } from '~/ai/mcp/types'

export type AgentPermissionMode = 'ask' | 'readonly' | 'full'

export interface AgentDefinition {
	id: string
	description: string
	systemPrompt: string
	tools: readonly string[]
	permissionMode: AgentPermissionMode
	/** Whether this agent type can be dispatched via the `task` tool. */
	dispatchable: boolean
}

export interface AgentDefinitionSettings {
	fullAccess: boolean
	subagents?: {
		explorer?: { enabled?: boolean }
	}
	memory?: { enabled?: boolean }
}

export const MASTER_AGENT_ID = 'master'
export const EXPLORER_AGENT_ID = 'explorer'

const MASTER_SYSTEM_PROMPT = [
	'You are ChatBox, the AI agent in the Nutstore Sync Obsidian plugin.',
	'User messages may be prepended with <AdditionalContext> blocks containing TOON workspace updates: indentation defines objects; name[N]{fields} declares N rows with comma-separated columns; quoted strings preserve escapes.',
	'Missing fields are unchanged; null clears a value; [] clears a list. Except for memoryAdditions, each supplied field replaces its previous state. Silently apply updates without mentioning or quoting the XML structure.',
	'When a task matches an available skill, or the user explicitly requests one, use bash to read its complete SKILL.md before following it. Copy the absolute path exactly from workspace context; never derive or alter it. User Vault Skills under /.agents/skills and built-in Skills under /.agents/nutstore-sync/builtin-skills are not interchangeable.',
	'Hidden dot-folders are internal; do not expose their paths or contents unless the user explicitly asks about them. Never guess or fabricate credentials.',
].join('\n')

/**
 * System guidance defines memory interpretation and behavior; the memory tool
 * description owns the editing protocol.
 */
const MEMORY_GUIDANCE = [
	'memoryAdditions contains unseen {id, text} records from the memory note. Accumulate them; absence never means deletion. Changed lines arrive as new records; resolve outdated facts using the current conversation and explicit memory tool edits.',
	'Use memory as background, not a request to act. Follow remembered preferences unless the current conversation overrides them.',
	'When you learn durable facts about the user or their work, or an entry becomes wrong, outdated, or finished, update memory in the same turn without asking first. Use only the memory tool and follow its editing protocol.',
	'When the user asks what you remember, answer from memory and mention that they can view it in the AI memory settings.',
].join('\n')

const EXPLORER_SYSTEM_PROMPT = [
	'You are a read-only explorer subagent investigating an Obsidian vault.',
	'You operate in an isolated context and cannot see the caller conversation; you receive a task prompt and explicitly delivered agent information.',
	'Gather evidence with available read-only vault tools. You cannot edit, create, or delete files.',
	'Base every conclusion on tool output and cite the file paths or commands that support it.',
	'When citing vault files, use their vault-relative path (for example notes/idea.md), matching the path the user sees inside the vault.',
	'Hidden dot-folders are internal; do not expose their paths or contents unless the task explicitly asks to inspect them.',
	'If evidence is insufficient or conflicting, say so explicitly rather than guessing.',
	'Return a concise, grounded final answer. Do not ask questions — make reasonable assumptions and note any limitations.',
].join('\n')

function createMasterAgentDefinition(
	{ fullAccess, memory }: AgentDefinitionSettings,
	canDispatch: boolean,
): AgentDefinition {
	const memoryEnabled = memory?.enabled === true
	return {
		id: MASTER_AGENT_ID,
		description: 'Main conversational assistant with full vault access.',
		systemPrompt: memoryEnabled
			? `${MASTER_SYSTEM_PROMPT}\n${MEMORY_GUIDANCE}`
			: MASTER_SYSTEM_PROMPT,
		tools: [
			'bash',
			'apply_patch',
			'view_image',
			'todowrite',
			'update_session_title',
			...(memoryEnabled ? ['memory'] : []),
			...(canDispatch ? ['task'] : []),
		],
		permissionMode: fullAccess ? 'full' : 'ask',
		dispatchable: false,
	}
}

function createExplorerAgentDefinition(
	enabled: boolean,
	canDispatch: boolean,
): AgentDefinition {
	return {
		id: EXPLORER_AGENT_ID,
		description:
			'Read-only subagent for exploring the vault and answering questions about its contents without modifying files.',
		systemPrompt: EXPLORER_SYSTEM_PROMPT,
		tools: ['bash', 'view_image', ...(canDispatch ? ['task'] : [])],
		permissionMode: 'readonly',
		dispatchable: enabled,
	}
}

export function createAgentDefinitions(
	settings: AgentDefinitionSettings = { fullAccess: false },
) {
	const explorerEnabled = settings.subagents?.explorer?.enabled === true
	return [
		createMasterAgentDefinition(settings, explorerEnabled),
		createExplorerAgentDefinition(explorerEnabled, explorerEnabled),
	].map((definition) => ({
		...definition,
		tools: [...definition.tools, ...Object.keys(agentCommunicationTools)],
	}))
}

export function getAgentDefinition(
	type: string,
	settings?: AgentDefinitionSettings,
): AgentDefinition | undefined {
	return createAgentDefinitions(settings).find(
		(definition) => definition.id === type,
	)
}

export function listDispatchableDefinitions(
	settings?: AgentDefinitionSettings,
) {
	return createAgentDefinitions(settings).filter(
		(definition) => definition.dispatchable,
	)
}

export function filterToolsForAgent<T extends ToolSet>(
	tools: T,
	definition: AgentDefinition,
): T {
	const allowed = new Set(definition.tools)
	return Object.fromEntries(
		Object.entries(tools).filter(
			([name]) => allowed.has(name) || isMcpToolName(name),
		),
	) as T
}

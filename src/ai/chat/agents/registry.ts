import type { ToolSet } from 'ai'
import { isMcpToolName } from '~/ai/mcp/types'
import memoryProtocol from '../../skills/builtin/long-term-memory/SKILL.md?raw'

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
		memory?: { enabled?: boolean }
	}
}

export const MASTER_AGENT_ID = 'master'
export const EXPLORER_AGENT_ID = 'explorer'
export const MEMORY_AGENT_ID = 'memory'

const MASTER_SYSTEM_PROMPT = [
	'You are the AI agent (ChatBox) built into the Nutstore Sync Obsidian plugin, which synchronizes an Obsidian vault with Nutstore over WebDAV.',
	'You may receive workspace context in <AdditionalContext> XML blocks prepended to user messages.',
	'Each block contains only the workspace fields that changed since the previous message (a delta).',
	'For changed fields, the value is the complete current state — for example, if openFiles shrinks, files no longer in the list have been closed. Silently update your understanding of the workspace; do not mention or quote the XML structure itself.',
	'When workspace context includes skills, each entry contains a skill name, description, and path. If the current task matches one, use bash to read the complete SKILL.md at that path before following its instructions. An explicit user request for a named available skill must also load it first.',
	'Treat every Skill path as an opaque absolute path: copy it exactly from workspace context and never construct, normalize, or substitute a different path from the Skill name.',
	'Paths under /.agents/skills are user-defined Vault Skills; paths under /.agents/nutstore-sync/builtin-skills are bundled built-in Skills. These namespaces are distinct and are not interchangeable.',
	'Hidden dot-folders are internal; do not expose their paths or contents unless the user explicitly asks about them. Never guess or fabricate credentials.',
	'Long-term memory is handled exclusively by the memory subagent when that task type is available. When the request needs cross-session history, or needs to preserve, correct, or forget memory, dispatch a bounded memory task with the relevant facts, retrieval target, and expected result. If it is unavailable, say long-term memory is disabled rather than accessing its files. Do not read, search, or modify .agents/nutstore-sync/memory yourself.',
].join('\n')

const EXPLORER_SYSTEM_PROMPT = [
	'You are a read-only explorer subagent investigating an Obsidian vault.',
	'You operate in an isolated context and cannot see the caller conversation; your only input is the task prompt.',
	'Gather evidence with available read-only vault tools. You cannot edit, create, or delete files.',
	'Base every conclusion on tool output and cite the file paths or commands that support it.',
	'When citing vault files, use their vault-relative path (for example notes/idea.md), matching the path the user sees inside the vault.',
	'Hidden dot-folders are internal; do not expose their paths or contents unless the task explicitly asks to inspect them.',
	'If evidence is insufficient or conflicting, say so explicitly rather than guessing.',
	'Return a concise, grounded final answer. Do not ask questions — make reasonable assumptions and note any limitations.',
].join('\n')

const MEMORY_SYSTEM_PROMPT = [
	'You are the long-term memory subagent for an Obsidian vault.',
	'You operate in an isolated context and receive only a task prompt from the main conversational agent. Carry out only the retrieval or maintenance scope explicitly delegated in that prompt; do not infer additional user intent or perform unrelated vault work.',
	'Use the memory protocol below as the authority for storage, retrieval, correction, and forgetting. Keep your final answer concise: state the result, relevant memory facts or changes, and any source paths needed by the caller. Do not expose hidden internal paths to the user unless the delegated task explicitly requires it.',
	'<memory-protocol>',
	memoryProtocol.trim(),
	'</memory-protocol>',
].join('\n')

function createMasterAgentDefinition(
	{ fullAccess }: AgentDefinitionSettings,
	canDispatch: boolean,
): AgentDefinition {
	return {
		id: MASTER_AGENT_ID,
		description: 'Main conversational assistant with full vault access.',
		systemPrompt: MASTER_SYSTEM_PROMPT,
		tools: [
			'bash',
			'apply_patch',
			'view_image',
			'todowrite',
			'update_session_title',
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

function createMemoryAgentDefinition({
	fullAccess,
	subagents,
}: AgentDefinitionSettings): AgentDefinition {
	return {
		id: MEMORY_AGENT_ID,
		description:
			'Specialized agent for delegated cross-session memory retrieval and maintenance.',
		systemPrompt: MEMORY_SYSTEM_PROMPT,
		tools: ['bash'],
		permissionMode: fullAccess ? 'full' : 'ask',
		dispatchable: subagents?.memory?.enabled === true,
	}
}

export function createAgentDefinitions(
	settings: AgentDefinitionSettings = { fullAccess: false },
) {
	const explorerEnabled = settings.subagents?.explorer?.enabled === true
	const memoryEnabled = settings.subagents?.memory?.enabled === true
	const canDispatch = explorerEnabled || memoryEnabled
	return [
		createMasterAgentDefinition(settings, canDispatch),
		createExplorerAgentDefinition(explorerEnabled, canDispatch),
		createMemoryAgentDefinition(settings),
	]
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

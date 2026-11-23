import type { ToolSet } from 'ai'
import { agentCommunicationTools } from '~/ai/tools/agent-communication'

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
	'User messages may include <AdditionalContext> with TOON workspace deltas: indentation defines objects; name[N]{fields} declares N comma-separated rows; quoted strings preserve escapes. Missing fields are unchanged; null clears a value; [] clears a list. Except for memoryAdditions, supplied fields replace prior state. Apply updates silently without mentioning the XML.',
	'When a task matches a skill or the user asks for one, read its full SKILL.md via bash using the exact absolute path from workspace context (never derive paths or confuse user and built-in skills).',
	'For App creation or editing, read the app-builder skill first. Code in a reply does not create an App; trust the host-supplied Current App workspace rather than inferring a target from old messages.',
].join('\n')

const EXPLORER_SYSTEM_PROMPT = [
	'You are a read-only explorer subagent investigating an Obsidian vault from the task prompt and delivered agent information.',
	'You cannot edit, create, or delete files. If evidence is insufficient or conflicting, state that explicitly rather than guessing.',
	'Do not ask questions — make reasonable assumptions, note limitations, and return a concise grounded answer (or clearly explain any failure).',
].join('\n')

function createMasterAgentDefinition(
	{ fullAccess, memory }: AgentDefinitionSettings,
	canDispatch: boolean,
): AgentDefinition {
	const memoryEnabled = memory?.enabled === true
	return {
		id: MASTER_AGENT_ID,
		description: 'Main conversational assistant with full vault access.',
		systemPrompt: MASTER_SYSTEM_PROMPT,
		tools: [
			'mcp_list_servers',
			'mcp_list_tools',
			'mcp_execute',
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
		Object.entries(tools).filter(([name]) => allowed.has(name)),
	) as T
}

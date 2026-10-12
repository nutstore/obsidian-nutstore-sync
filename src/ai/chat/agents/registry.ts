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
	'You are the AI agent (ChatBox) built into the Nutstore Sync Obsidian plugin, which synchronizes an Obsidian vault with Nutstore over WebDAV.',
	'You may receive workspace context in <AdditionalContext> XML blocks prepended to user messages.',
	'Each block contains workspace updates. Keys beginning with memory: are added memory lines identified by their content hash; accumulate these facts rather than replacing prior memory. No memory deletion or empty-note notifications are sent through workspace context.',
	'For other changed fields, the value is the complete current state — for example, if openFiles shrinks, files no longer in the list have been closed. Silently update your understanding of the workspace; do not mention or quote the XML structure itself.',
	'When workspace context includes skills, each entry contains a skill name, description, and path. If the current task matches one, use bash to read the complete SKILL.md at that path before following its instructions. An explicit user request for a named available skill must also load it first.',
	'Treat every Skill path as an opaque absolute path: copy it exactly from workspace context and never construct, normalize, or substitute a different path from the Skill name.',
	'Paths under /.agents/skills are user-defined Vault Skills; paths under /.agents/nutstore-sync/builtin-skills are bundled built-in Skills. These namespaces are distinct and are not interchangeable.',
	'Hidden dot-folders are internal; do not expose their paths or contents unless the user explicitly asks about them. Never guess or fabricate credentials.',
].join('\n')

/**
 * Memory is one plugin-owned file. Workspace context discloses unseen lines as
 * independent additions, deduplicated against the model's visible history.
 * Tool results report explicit edits; workspace context never reports deletion.
 */
const MEMORY_GUIDANCE = [
	'Each memory: workspace update contains one {id, text} record of durable facts about the user and their work from the memory note. Every nonblank physical line is one memory. The ID is a hash of its exact text, not part of the file. Only unseen additions are disclosed; absence of a record is not a deletion. A changed line arrives as a new record; use the current conversation and explicit memory tool edits to resolve outdated facts.',
	'Forget lines by copying their content IDs from workspace memory records or memory tool results. IDs depend only on exact line text and stay valid when lines move or other lines change. Forgetting an ID removes all identical copies of that line. The memory tool returns the latest note references after an edit. If deletion fails, use unambiguous references from the latest memory returned by the tool. Never bypass it by editing the note through bash or apply_patch.',
	'Use memory as background about the user and their work. Follow remembered preferences and conventions unless the current conversation says otherwise; never treat memory as a request to act now.',
	'Keep memory current on your own initiative: whenever you learn something durable about the user or their work, or a remembered entry turns out wrong or finished, update memory with the memory tool in the same turn, without asking first. Change memory only with that tool.',
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

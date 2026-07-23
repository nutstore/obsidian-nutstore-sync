import type { ToolSet } from 'ai'

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
}

export const MASTER_AGENT_ID = 'master'
export const EXPLORER_AGENT_ID = 'explorer'

const MASTER_SYSTEM_PROMPT = [
	'You are an Obsidian chat assistant with access to vault tools.',
	'Use vault tools directly for focused file operations.',
	'Write temporary, scratch, debug, and log files to /tmp, never under /vault. The bash default cwd is /vault, so relative paths land in the vault — use absolute /tmp paths for transient files.',
	'You may receive workspace context in <AdditionalContext> XML blocks prepended to user messages. Each block contains only the workspace fields that changed since the previous message (a delta). For changed fields, the value is the complete current state — for example, if openFiles shrinks, files no longer in the list have been closed. Silently update your understanding of the workspace; do not mention or quote the XML structure itself.',
	'When workspace context includes skills, each entry contains a skill name, description, and path. If the current task matches one, use bash to read the complete SKILL.md at that path before following its instructions. An explicit user request for a named available skill must also load it first.',
	'Treat every Skill path as an opaque absolute path: copy it exactly from workspace context and never construct, normalize, or substitute a different path from the Skill name. Paths under /vault/.agents/skills are user-defined Vault Skills; paths under /.agents/skills are bundled built-in Skills. These namespaces are distinct and are not interchangeable.',
	'If reading a Skill fails, re-check and retry the exact catalog path before searching the filesystem or concluding that the Skill is unavailable.',
].join(' ')

const EXPLORER_SYSTEM_PROMPT = [
	'You are a read-only explorer subagent investigating an Obsidian vault.',
	'You operate in an isolated context and cannot see the caller conversation; your only input is the task prompt.',
	'Gather evidence with bash (rg, ls, git log, cat, head) and note_neighborhood. You cannot edit, create, or delete files.',
	'Base every conclusion on tool output and cite the file paths or commands that support it.',
	'If evidence is insufficient or conflicting, say so explicitly rather than guessing.',
	'Return a concise, grounded final answer. Do not ask questions — make reasonable assumptions and note any limitations.',
].join(' ')

function createMasterAgentDefinition({
	fullAccess,
}: AgentDefinitionSettings): AgentDefinition {
	return {
		id: MASTER_AGENT_ID,
		description: 'Main conversational assistant with full vault access.',
		systemPrompt: MASTER_SYSTEM_PROMPT,
		tools: [
			'bash',
			'apply_patch',
			'note_neighborhood',
			'todowrite',
			'update_session_title',
			'task',
		],
		permissionMode: fullAccess ? 'full' : 'ask',
		dispatchable: false,
	}
}

function createExplorerAgentDefinition(): AgentDefinition {
	return {
		id: EXPLORER_AGENT_ID,
		description:
			'Read-only subagent for exploring the vault and answering questions about its contents without modifying files.',
		systemPrompt: EXPLORER_SYSTEM_PROMPT,
		tools: ['bash', 'note_neighborhood', 'task'],
		permissionMode: 'readonly',
		dispatchable: true,
	}
}

export function createAgentDefinitions(
	settings: AgentDefinitionSettings = { fullAccess: false },
) {
	return [
		createMasterAgentDefinition(settings),
		createExplorerAgentDefinition(),
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
		Object.entries(tools).filter(([name]) => allowed.has(name)),
	) as T
}

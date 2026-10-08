import { describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import {
	createAgentDefinitions,
	EXPLORER_AGENT_ID,
	filterToolsForAgent,
	MASTER_AGENT_ID,
} from './registry'

function findDefinition(
	definitions: ReturnType<typeof createAgentDefinitions>,
	id: string,
) {
	const definition = definitions.find((candidate) => candidate.id === id)
	if (!definition) throw new Error(`Expected ${id} agent definition`)
	return definition
}

describe('createAgentDefinitions', () => {
	it('rebuilds definitions from current settings without elevating explorer', () => {
		const askDefinitions = createAgentDefinitions({
			fullAccess: false,
			subagents: { explorer: { enabled: true } },
		})
		const fullDefinitions = createAgentDefinitions({
			fullAccess: true,
			subagents: { explorer: { enabled: true } },
		})

		expect(fullDefinitions).not.toBe(askDefinitions)
		expect(findDefinition(askDefinitions, MASTER_AGENT_ID).permissionMode).toBe(
			'ask',
		)
		expect(
			findDefinition(fullDefinitions, MASTER_AGENT_ID).permissionMode,
		).toBe('full')
		expect(
			findDefinition(fullDefinitions, EXPLORER_AGENT_ID).permissionMode,
		).toBe('readonly')
	})

	it('keeps disabled agents addressable without exposing task', () => {
		const definitions = createAgentDefinitions({ fullAccess: false })

		expect(findDefinition(definitions, EXPLORER_AGENT_ID).dispatchable).toBe(
			false,
		)
		expect(findDefinition(definitions, MASTER_AGENT_ID).tools).not.toContain(
			'task',
		)
	})

	it('exposes only enabled subagent types and task tools', () => {
		const definitions = createAgentDefinitions({
			fullAccess: false,
			subagents: { explorer: { enabled: true } },
		})

		expect(
			definitions
				.filter((definition) => definition.dispatchable)
				.map((definition) => definition.id),
		).toEqual([EXPLORER_AGENT_ID])
		expect(findDefinition(definitions, MASTER_AGENT_ID).tools).toContain('task')
		expect(findDefinition(definitions, EXPLORER_AGENT_ID).tools).toContain(
			'task',
		)
	})

	it('gives only the master agent memory, together with its guidance', () => {
		const enabled = createAgentDefinitions({
			fullAccess: false,
			subagents: { explorer: { enabled: true } },
			memory: { enabled: true },
		})
		const master = findDefinition(enabled, MASTER_AGENT_ID)
		expect(master.tools).toContain('memory')
		expect(master.systemPrompt).toContain('memory note')
		expect(findDefinition(enabled, EXPLORER_AGENT_ID).tools).not.toContain(
			'memory',
		)

		const disabled = findDefinition(
			createAgentDefinitions({ fullAccess: false, memory: { enabled: false } }),
			MASTER_AGENT_ID,
		)
		expect(disabled.tools).not.toContain('memory')
		expect(disabled.systemPrompt).not.toContain('memory note')
	})
})

describe('filterToolsForAgent', () => {
	it('keeps mcp-prefixed tools while filtering unknown built-in tools', () => {
		const tools = {
			bash: {},
			unknown_builtin: {},
			'mcp__notes-search__find_notes': {},
			mcp__翻译工具__translate: {},
		} as unknown as ToolSet
		const definition = findDefinition(
			createAgentDefinitions({ fullAccess: false }),
			MASTER_AGENT_ID,
		)

		const filtered = filterToolsForAgent(tools, definition)
		expect(Object.keys(filtered).sort()).toEqual([
			'bash',
			'mcp__notes-search__find_notes',
			'mcp__翻译工具__translate',
		])
	})
})

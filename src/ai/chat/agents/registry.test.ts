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
		const askDefinitions = createAgentDefinitions({ fullAccess: false })
		const fullDefinitions = createAgentDefinitions({ fullAccess: true })

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

import { describe, expect, it } from 'vitest'
import {
	createAgentDefinitions,
	EXPLORER_AGENT_ID,
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

import { describe, expect, it } from 'vitest'
import { getAgentDefinition } from '~/ai/chat/agents/registry'
import { createSystemPromptForAgent } from './prompts'

describe('main system prompt Skills guidance', () => {
	it('loads matching Skill paths through Bash without use_skill', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).toContain('skill name, description, and path')
		expect(prompt).toContain('use bash to read the complete SKILL.md')
		expect(prompt).toContain('copy it exactly from workspace context')
		expect(prompt).toContain(
			'Paths under /vault/.agents/skills are user-defined Vault Skills',
		)
		expect(prompt).toContain(
			'paths under /.agents/skills are bundled built-in Skills',
		)
		expect(prompt).toContain('These namespaces are distinct')
		expect(prompt).toContain('retry the exact catalog path')
		expect(prompt).not.toContain('call use_skill')
		expect(prompt).not.toContain('background_output')
		expect(prompt).not.toContain('subagent_type')
	})
})

describe('vault instructions', () => {
	it('appends vault instructions wrapped in XML tags when provided', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const instructions = 'Always reply in a friendly tone.'
		const prompt = createSystemPromptForAgent(
			definition,
			undefined,
			instructions,
		)

		expect(prompt).toContain('<vault-instructions>')
		expect(prompt).toContain(instructions)
		expect(prompt).toContain('</vault-instructions>')
	})

	it('omits vault-instructions block when content is empty', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const prompt = createSystemPromptForAgent(definition, undefined, '')

		expect(prompt).not.toContain('<vault-instructions>')
	})

	it('omits vault-instructions block when not provided', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).not.toContain('<vault-instructions>')
	})
})

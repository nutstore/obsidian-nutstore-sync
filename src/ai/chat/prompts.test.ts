import { describe, expect, it } from 'vitest'
import { getAgentDefinition } from '~/ai/chat/agents/registry'
import {
	buildAgentSystemPrompt,
	CHECKPOINT_PREAMBLE,
	COMPRESSION_PROMPT,
	createSystemPromptForAgent,
} from './prompts'

describe('main system prompt Skills guidance', () => {
	it('loads matching Skill paths through Bash without use_skill', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).toContain('skill name, description, and path')
		expect(prompt).toContain('use bash to read the complete SKILL.md')
		expect(prompt).toContain('copy it exactly from workspace context')
		expect(prompt).toContain(
			'Paths under /.agents/skills are user-defined Vault Skills',
		)
		expect(prompt).toContain(
			'paths under /.agents/nutstore-sync/builtin-skills are bundled built-in Skills',
		)
		expect(prompt).toContain('These namespaces are distinct')
		expect(prompt).toContain(
			'Treat every Skill path as an opaque absolute path',
		)
		expect(prompt).not.toContain('call use_skill')
		expect(prompt).not.toContain('background_output')
		expect(prompt).not.toContain('subagent_type')
		expect(prompt).not.toContain('MCP servers are configured')
	})

	it('states the agent identity and its environment', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).toContain('Nutstore Sync Obsidian plugin')
		expect(prompt).toContain('Obsidian vault')
		expect(prompt).toContain('WebDAV')
	})

	it('delegates long-term memory instead of exposing it to the main agent', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).toContain('memory subagent')
		expect(prompt).toContain('dispatch a bounded memory task')
		expect(prompt).toContain('long-term memory is disabled')
		expect(prompt).toContain('Do not read, search, or modify')
		expect(prompt).not.toContain('<memory-protocol>')
	})
})

describe('virtual filesystem guidance', () => {
	it('describes stable mounts without turning them into an exploration request', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).toContain('<virtual-filesystem>')
		expect(prompt).toContain('/ is the Obsidian vault base filesystem')
		expect(prompt).toContain('/.agents/nutstore-sync/builtin-skills')
		expect(prompt).toContain('/.config/nutstore-sync/settings.json')
		expect(prompt).toContain(
			'This is a routing map, not an instruction to enumerate or scan every mount',
		)
		expect(prompt).toContain(
			'Start with the smallest relevant scope and broaden only when evidence is insufficient',
		)
		expect(prompt).not.toContain('/.agents/nutstore-sync/memory')
		expect(prompt).not.toContain(
			'For ambiguous user requests, you may broaden exploration',
		)
	})

	it('gives the read-only explorer the same filesystem routing map', () => {
		const definition = getAgentDefinition('explorer')
		if (!definition) throw new Error('Expected explorer agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).toContain('<virtual-filesystem>')
		expect(prompt).toContain('/.agents/nutstore-sync/tmp')
		expect(prompt).toContain('read-only explorer subagent')
	})

	it('gives the memory agent its private protocol and constrained tools', () => {
		const definition = getAgentDefinition('memory')
		if (!definition) throw new Error('Expected memory agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(definition.tools).toEqual(['bash'])
		expect(prompt).toContain('<memory-protocol>')
		expect(prompt).toContain('memory/archive/<YYYY>/<YYYY-MM-DD>.md')
		expect(prompt).toContain('isolated context')
	})
})

describe('user-facing path convention', () => {
	it('instructs the master agent to use vault-relative paths when replying to the user', () => {
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).toContain('vault-relative path')
		expect(prompt).toContain('notes/idea.md')
		expect(prompt).not.toContain('/vault')
		expect(prompt).toContain('Hidden dot-folders')
		expect(prompt).toContain('do not expose their paths or contents')
	})

	it('instructs the explorer agent to cite real vault-relative paths', () => {
		const definition = getAgentDefinition('explorer')
		if (!definition) throw new Error('Expected explorer agent definition')
		const prompt = createSystemPromptForAgent(definition)

		expect(prompt).toContain('vault-relative path')
		expect(prompt).toContain('matching the path the user sees inside the vault')
		expect(prompt).not.toContain('/vault')
		expect(prompt).toContain('Hidden dot-folders')
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

describe('compression checkpoint', () => {
	it('uses a note-scenario structure with vault-relative and language-neutral rules', () => {
		expect(COMPRESSION_PROMPT).toContain('Obsidian note-taking assistant')
		expect(COMPRESSION_PROMPT).toContain('## User Goals')
		expect(COMPRESSION_PROMPT).toContain('## Vault Context')
		expect(COMPRESSION_PROMPT).toContain('## Vault Files Touched')
		expect(COMPRESSION_PROMPT).toContain('## Issues and Resolutions')
		expect(COMPRESSION_PROMPT).toContain('## Pending Requests')
		expect(COMPRESSION_PROMPT).toContain('## Current Work')
		expect(COMPRESSION_PROMPT).toContain('## Next Step')
		expect(COMPRESSION_PROMPT).toContain('## Critical Context')
		expect(COMPRESSION_PROMPT).toContain(
			'Use vault-relative paths for vault files',
		)
		expect(COMPRESSION_PROMPT).not.toContain('/vault')
		expect(COMPRESSION_PROMPT).toContain('hidden dot-folders')
		expect(COMPRESSION_PROMPT).toContain(
			'in the same language as the conversation',
		)
		expect(COMPRESSION_PROMPT).toContain('PRIOR checkpoint')
		expect(COMPRESSION_PROMPT).not.toContain('function signatures')
		expect(COMPRESSION_PROMPT).not.toContain('English engineering prose')
	})

	it('exposes a checkpoint preamble for the derived transcript', () => {
		expect(CHECKPOINT_PREAMBLE).toContain('established background')
		expect(CHECKPOINT_PREAMBLE).toContain(
			'without acknowledging this checkpoint',
		)
	})
})

describe('buildAgentSystemPrompt', () => {
	it('wraps AGENTS.md in vault-instructions for the master agent', async () => {
		const app = {
			vault: { adapter: { read: async () => 'Always be concise.' } },
		} as never
		const prompt = await buildAgentSystemPrompt(app, 'master', 'SESSION')
		expect(prompt).toContain('SESSION')
		expect(prompt).toContain('<vault-instructions>')
		expect(prompt).toContain('Always be concise.')
	})

	it('appends the built-in guidance for the master agent', async () => {
		const app = {
			vault: { adapter: { read: async () => 'x' } },
		} as never
		const prompt = await buildAgentSystemPrompt(app, 'master')
		expect(prompt).toContain('Use todowrite to create and maintain')
		expect(prompt).toContain('vault-relative path')
	})

	it('degrades to no AGENTS.md instructions when the file is missing', async () => {
		const app = {
			vault: {
				adapter: {
					read: async (): Promise<string> => {
						throw new Error('ENOENT')
					},
				},
			},
		} as never
		const prompt = await buildAgentSystemPrompt(app, 'explorer')
		expect(prompt).not.toContain('<vault-instructions>')
		expect(prompt).toContain('read-only explorer subagent')
	})

	it('rejects an unknown agent type', async () => {
		const app = { vault: { adapter: { read: async () => undefined } } } as never
		await expect(buildAgentSystemPrompt(app, 'nope')).rejects.toThrow(
			'Unknown agent type',
		)
	})
})

import { describe, expect, it } from 'vitest'
import {
	BUILTIN_SKILLS,
	BUILTIN_SKILLS_ROOT,
	createBuiltinSkillsFs,
} from './builtin'

describe('built-in Skills', () => {
	it('ships a self-consistent Nutstore Sync guide', () => {
		const skill = BUILTIN_SKILLS.find(
			(item) => item.name === 'nutstore-sync-guide',
		)

		expect(skill).toBeDefined()
		expect(skill!.path).toBe(
			`${BUILTIN_SKILLS_ROOT}/nutstore-sync-guide/SKILL.md`,
		)
		expect(skill!.content).toContain('\nname: nutstore-sync-guide\n')
		expect(skill!.content).toContain(`description: ${skill!.description}\n`)
		expect(skill!.content).toContain('MCP server configuration')
		expect(skill!.resources?.map((resource) => resource.path)).toEqual([
			'references/ai-chatbox.md',
			'references/mcp-servers.md',
			'references/sync.md',
		])
	})

	it('mounts Nutstore Sync references below the guide', async () => {
		const fs = await createBuiltinSkillsFs()
		const [mcpContent, syncContent] = await Promise.all([
			fs.readFile('/nutstore-sync-guide/references/mcp-servers.md'),
			fs.readFile('/nutstore-sync-guide/references/sync.md'),
		])

		expect(mcpContent).toContain('MCP server configuration')
		expect(syncContent).toContain('Sync policies')
		expect(syncContent).toContain('Diff3')
	})

	it('ships a self-consistent skill-creator definition', () => {
		const skill = BUILTIN_SKILLS.find((item) => item.name === 'skill-creator')

		expect(skill).toBeDefined()
		expect(skill!.path).toBe(`${BUILTIN_SKILLS_ROOT}/skill-creator/SKILL.md`)
		expect(skill!.content).toContain('\nname: skill-creator\n')
		expect(skill!.content).toContain(`description: ${skill!.description}\n`)
		expect(skill!.content).toContain(
			'Do not unnecessarily restrict which tools the agent may use.',
		)
	})
})

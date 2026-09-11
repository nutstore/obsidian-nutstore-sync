import { describe, expect, it } from 'vitest'
import {
	BUILTIN_SKILLS,
	BUILTIN_SKILLS_ROOT,
	createBuiltinSkillsFs,
	isBuiltinSkillPath,
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
			'references/filter-rules.md',
			'references/mcp-servers.md',
			'references/settings.md',
			'references/sync.md',
		])
	})

	it('mounts Nutstore Sync references below the guide', async () => {
		const fs = await createBuiltinSkillsFs()
		const [mcpContent, settingsContent, syncContent] = await Promise.all([
			fs.readFile('/nutstore-sync-guide/references/mcp-servers.md'),
			fs.readFile('/nutstore-sync-guide/references/settings.md'),
			fs.readFile('/nutstore-sync-guide/references/sync.md'),
		])

		expect(mcpContent).toContain('MCP Server Configuration')
		expect(mcpContent).toContain('/.agents/nutstore-sync/mcp.json')
		expect(settingsContent).toContain('Plugin Settings File')
		expect(settingsContent).toContain('filterRules')
		expect(settingsContent).toContain('/.config/nutstore-sync/settings.json')
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

	it('keeps the long-term-memory protocol out of the public Skill catalog', () => {
		expect(
			BUILTIN_SKILLS.some((item) => item.name === 'long-term-memory'),
		).toBe(false)
	})

	it('classifies every shipped Skill path as built-in', () => {
		for (const skill of BUILTIN_SKILLS) {
			expect(isBuiltinSkillPath(skill.path)).toBe(true)
		}
		expect(isBuiltinSkillPath('/.agents/skills/example-skill/SKILL.md')).toBe(
			false,
		)
		expect(isBuiltinSkillPath(BUILTIN_SKILLS_ROOT)).toBe(false)
	})

	it('mounts every built-in Skill under the read-only skills filesystem', async () => {
		const fs = await createBuiltinSkillsFs()
		const names = BUILTIN_SKILLS.map((skill) => skill.name)
		const mounted = await Promise.all(
			names.map(async (name) => fs.readFile(`/${name}/SKILL.md`)),
		)
		expect(mounted.length).toBe(names.length)
		expect(mounted.every((content) => content.length > 0)).toBe(true)
	})
})

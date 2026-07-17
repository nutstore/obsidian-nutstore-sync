import { describe, expect, it } from 'vitest'
import { BUILTIN_SKILLS, BUILTIN_SKILLS_ROOT } from './builtin'

describe('built-in Skills', () => {
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

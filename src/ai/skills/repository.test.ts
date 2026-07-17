import { describe, expect, it } from 'vitest'
import {
	MAX_SKILL_MARKDOWN_BYTES,
	SkillRepository,
} from '~/ai/skills/repository'
import type { BuiltinSkill } from '~/ai/skills/types'

interface SkillEntry {
	name: string
	description?: string
	frontmatterName?: string
	size?: number
	content?: string
}

function createRepository(
	entries: SkillEntry[],
	builtinSkills: BuiltinSkill[] = [],
) {
	const files = new Map(
		entries.map((entry) => {
			const content =
				entry.content ??
				`---\nname: ${entry.frontmatterName ?? entry.name}\n${
					entry.description ? `description: ${entry.description}\n` : ''
				}---\n\n# ${entry.name}`
			return [`.agents/skills/${entry.name}/SKILL.md`, { entry, content }]
		}),
	)
	const folders = entries.map((entry) => `.agents/skills/${entry.name}`)
	const adapter = {
		exists: async (path: string) =>
			path === '.agents/skills' || files.has(path),
		list: async (path: string) => {
			if (path !== '.agents/skills') return { files: [], folders: [] }
			return { files: [], folders }
		},
		stat: async (path: string) => {
			const file = files.get(path)
			if (!file) return null
			return {
				type: 'file' as const,
				size:
					file.entry.size ?? new TextEncoder().encode(file.content).byteLength,
				ctime: 0,
				mtime: 0,
			}
		},
		read: async (path: string) => files.get(path)?.content ?? '',
	}
	const app = { vault: { adapter } }
	return new SkillRepository(app as never, builtinSkills)
}

describe('SkillRepository', () => {
	it('discovers hidden Vault Skills through the adapter in deterministic order', async () => {
		const repository = createRepository([
			{ name: 'z-last', description: 'Last skill' },
			{ name: 'a-first', description: 'First skill' },
		])

		await repository.refresh()

		expect(repository.getCatalog()).toEqual([
			{
				name: 'a-first',
				description: 'First skill',
				path: '/vault/.agents/skills/a-first/SKILL.md',
			},
			{
				name: 'z-last',
				description: 'Last skill',
				path: '/vault/.agents/skills/z-last/SKILL.md',
			},
		])
	})

	it('exposes built-in Skills before the first adapter refresh', () => {
		const repository = createRepository(
			[],
			[
				{
					name: 'skill-creator',
					description: 'Create Skills',
					path: '/.agents/skills/skill-creator/SKILL.md',
					content: '# Skill Creator',
				},
			],
		)

		expect(repository.getCatalog()).toEqual([
			{
				name: 'skill-creator',
				description: 'Create Skills',
				path: '/.agents/skills/skill-creator/SKILL.md',
			},
		])
	})

	it('lets a hidden Vault Skill override a same-named built-in', async () => {
		const repository = createRepository(
			[{ name: 'skill-creator', description: 'Customized creator' }],
			[
				{
					name: 'skill-creator',
					description: 'Built-in creator',
					path: '/.agents/skills/skill-creator/SKILL.md',
					content: '# Built-in',
				},
			],
		)

		await repository.refresh()

		expect(repository.getCatalog()[0]).toEqual({
			name: 'skill-creator',
			description: 'Customized creator',
			path: '/vault/.agents/skills/skill-creator/SKILL.md',
		})
		expect(repository.discover().diagnostics).toContainEqual({
			path: '.agents/skills/skill-creator/SKILL.md',
			message: expect.stringContaining('overrides built-in Skill'),
		})
	})

	it('skips malformed and oversized Adapter Skills with diagnostics', async () => {
		const repository = createRepository([
			{
				name: 'mismatch',
				frontmatterName: 'other',
				description: 'Wrong name',
			},
			{ name: 'missing' },
			{
				name: 'large',
				description: 'Too large',
				size: MAX_SKILL_MARKDOWN_BYTES + 1,
			},
		])

		await repository.refresh()

		expect(repository.getCatalog()).toEqual([])
		expect(repository.discover().diagnostics).toHaveLength(3)
	})
})

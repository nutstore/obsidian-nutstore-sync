import { InMemoryFs, type IFileSystem } from 'just-bash/browser'
import { BUILTIN_SKILLS_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
import skillCreatorContent from './builtin/skill-creator/SKILL.md?raw'
import type { BuiltinSkill } from './types'

export const BUILTIN_SKILLS_ROOT = BUILTIN_SKILLS_MOUNT_POINT

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
	{
		name: 'skill-creator',
		description:
			'Create and define agent Skills in the current Obsidian vault. Use when the user asks to create a Skill, write a SKILL.md file, or turn a workflow into reusable agent instructions.',
		path: `${BUILTIN_SKILLS_ROOT}/skill-creator/SKILL.md`,
		content: skillCreatorContent,
	},
]

export async function createBuiltinSkillsFs(): Promise<IFileSystem> {
	const fs = new InMemoryFs()
	for (const skill of BUILTIN_SKILLS) {
		await fs.mkdir(`/${skill.name}`, { recursive: true })
		await fs.writeFile(`/${skill.name}/SKILL.md`, skill.content)
	}
	const mutations = new Set([
		'writeFile',
		'appendFile',
		'mkdir',
		'rm',
		'cp',
		'mv',
		'chmod',
		'symlink',
		'link',
		'utimes',
	])
	return new Proxy(fs, {
		get(target, property, receiver) {
			if (typeof property === 'string' && mutations.has(property)) {
				return async (...args: unknown[]) => {
					throw new Error(
						`EROFS: read-only built-in Skills path '${String(args[0] ?? '/')}'`,
					)
				}
			}
			const value = Reflect.get(target, property, receiver) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	}) as IFileSystem
}

import { InMemoryFs, type IFileSystem } from 'just-bash/browser'
import { posix as pathPosix } from 'path-browserify'
import { BUILTIN_SKILLS_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
import aiChatboxReferenceContent from './builtin/nutstore-sync-guide/references/ai-chatbox.md?raw'
import mcpServersReferenceContent from './builtin/nutstore-sync-guide/references/mcp-servers.md?raw'
import nutstoreSyncGuideContent from './builtin/nutstore-sync-guide/SKILL.md?raw'
import syncReferenceContent from './builtin/nutstore-sync-guide/references/sync.md?raw'
import skillCreatorContent from './builtin/skill-creator/SKILL.md?raw'
import type { BuiltinSkill } from './types'

export const BUILTIN_SKILLS_ROOT = BUILTIN_SKILLS_MOUNT_POINT

export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
	{
		name: 'nutstore-sync-guide',
		description:
			'Explain and operate Nutstore Sync features—including syncing, AI ChatBox, and MCP server configuration—when users ask for plugin help, setup, or troubleshooting.',
		path: `${BUILTIN_SKILLS_ROOT}/nutstore-sync-guide/SKILL.md`,
		content: nutstoreSyncGuideContent,
		resources: [
			{
				path: 'references/ai-chatbox.md',
				content: aiChatboxReferenceContent,
			},
			{
				path: 'references/mcp-servers.md',
				content: mcpServersReferenceContent,
			},
			{
				path: 'references/sync.md',
				content: syncReferenceContent,
			},
		],
	},
	{
		name: 'skill-creator',
		description:
			'Create and define agent Skills in the current Obsidian vault. Use when the user asks to create a Skill, write a SKILL.md file, or turn a workflow into reusable agent instructions.',
		path: `${BUILTIN_SKILLS_ROOT}/skill-creator/SKILL.md`,
		content: skillCreatorContent,
	},
]

function resolveBuiltinResourcePath(skillName: string, resourcePath: string) {
	const normalized = pathPosix.normalize(resourcePath)
	if (
		pathPosix.isAbsolute(resourcePath) ||
		normalized === '.' ||
		normalized === '..' ||
		normalized.startsWith('../')
	) {
		throw new Error(
			`Built-in Skill resource path must stay within '${skillName}': ${resourcePath}`,
		)
	}
	return `/${skillName}/${normalized}`
}

export async function createBuiltinSkillsFs(): Promise<IFileSystem> {
	const fs = new InMemoryFs()
	for (const skill of BUILTIN_SKILLS) {
		await fs.mkdir(`/${skill.name}`, { recursive: true })
		await fs.writeFile(`/${skill.name}/SKILL.md`, skill.content)
		for (const resource of skill.resources ?? []) {
			const path = resolveBuiltinResourcePath(skill.name, resource.path)
			await fs.mkdir(pathPosix.dirname(path), { recursive: true })
			await fs.writeFile(path, resource.content)
		}
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

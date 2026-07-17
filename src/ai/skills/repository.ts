import { App, normalizePath, parseYaml } from 'obsidian'
import { BUILTIN_SKILLS } from '~/ai/skills/builtin'
import type {
	BuiltinSkill,
	SkillMetadata,
	SkillDiagnostic,
} from '~/ai/skills/types'

export const SKILLS_ROOT = '.agents/skills'
export const VAULT_SKILLS_ROOT = `/vault/${SKILLS_ROOT}`
export const MAX_SKILL_MARKDOWN_BYTES = 64 * 1024

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

interface SkillFrontmatter {
	name?: unknown
	description?: unknown
}

function validateMetadata(
	directoryName: string,
	path: string,
	frontmatter: SkillFrontmatter | undefined,
	size: number,
): { skill?: SkillMetadata; diagnostic?: SkillDiagnostic } {
	const name =
		typeof frontmatter?.name === 'string' ? frontmatter.name.trim() : ''
	const description =
		typeof frontmatter?.description === 'string'
			? frontmatter.description.trim()
			: ''

	if (!name || !description) {
		return {
			diagnostic: {
				path,
				message: 'Skill frontmatter requires non-empty name and description.',
			},
		}
	}
	if (
		name.length > 64 ||
		!SKILL_NAME_PATTERN.test(name) ||
		name !== directoryName
	) {
		return {
			diagnostic: {
				path,
				message:
					'Skill name must match its directory and contain only lowercase letters, numbers, and single hyphens.',
			},
		}
	}
	if (description.length > 1024) {
		return {
			diagnostic: {
				path,
				message: 'Skill description must not exceed 1024 characters.',
			},
		}
	}
	if (size > MAX_SKILL_MARKDOWN_BYTES) {
		return {
			diagnostic: {
				path,
				message: `Skill file must not exceed ${MAX_SKILL_MARKDOWN_BYTES} bytes.`,
			},
		}
	}

	return {
		skill: {
			name,
			description,
			path: `${VAULT_SKILLS_ROOT}/${name}/SKILL.md`,
		},
	}
}

function parseFrontmatter(content: string) {
	const match = FRONTMATTER_PATTERN.exec(content)
	if (!match) return undefined
	return parseYaml(match[1]) as SkillFrontmatter
}

export class SkillRepository {
	private skills: SkillMetadata[]
	private diagnostics: SkillDiagnostic[] = []

	constructor(
		private app: App,
		private builtinSkills: readonly BuiltinSkill[] = BUILTIN_SKILLS,
	) {
		this.skills = this.getBuiltinMetadata()
	}

	private getBuiltinMetadata() {
		return this.builtinSkills.map(({ name, description, path }) => ({
			name,
			description,
			path,
		}))
	}

	async refresh(): Promise<void> {
		const skillsByName = new Map<string, SkillMetadata>(
			this.getBuiltinMetadata().map((skill) => [skill.name, skill]),
		)
		const diagnostics: SkillDiagnostic[] = []
		const adapter = this.app.vault.adapter

		try {
			if (await adapter.exists(SKILLS_ROOT)) {
				const listed = await adapter.list(SKILLS_ROOT)
				const folders = listed.folders
					.map((path) => normalizePath(path))
					.sort((left, right) => left.localeCompare(right))

				for (const folder of folders) {
					const directoryName = folder.split('/').at(-1) ?? ''
					const skillPath = normalizePath(`${folder}/SKILL.md`)
					const stat = await adapter.stat(skillPath)
					if (!stat || stat.type !== 'file') continue

					let frontmatter: SkillFrontmatter | undefined
					try {
						const content = await adapter.read(skillPath)
						if (content.includes('\0')) {
							throw new Error('Skill file is not UTF-8 text.')
						}
						frontmatter = parseFrontmatter(content)
					} catch (error) {
						diagnostics.push({
							path: skillPath,
							message:
								error instanceof Error
									? error.message
									: 'Unable to parse Skill frontmatter.',
						})
						continue
					}

					const result = validateMetadata(
						directoryName,
						skillPath,
						frontmatter,
						stat.size,
					)
					if (result.skill) {
						if (skillsByName.has(result.skill.name)) {
							diagnostics.push({
								path: skillPath,
								message: `Vault Skill '${result.skill.name}' overrides built-in Skill with the same name.`,
							})
						}
						skillsByName.set(result.skill.name, result.skill)
					}
					if (result.diagnostic) diagnostics.push(result.diagnostic)
				}
			}
		} catch (error) {
			diagnostics.push({
				path: SKILLS_ROOT,
				message:
					error instanceof Error
						? error.message
						: 'Unable to discover Vault Skills.',
			})
		}

		this.skills = [...skillsByName.values()].sort((left, right) =>
			left.name.localeCompare(right.name),
		)
		this.diagnostics = diagnostics
	}

	discover(): {
		skills: SkillMetadata[]
		diagnostics: SkillDiagnostic[]
	} {
		return {
			skills: this.skills.map((skill) => ({ ...skill })),
			diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		}
	}

	getCatalog(): SkillMetadata[] {
		return this.skills.map((skill) => ({ ...skill }))
	}
}

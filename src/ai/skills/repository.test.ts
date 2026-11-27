import type { App } from 'obsidian'
import { describe, expect, it } from 'vitest'
import { MemoryVault } from '@test/harness/memory-vault'
import { BUILTIN_SKILLS } from '~/ai/skills/builtin'
import { SkillRepository, SKILLS_ROOT } from '~/ai/skills/repository'
import { ObsidianVaultFs } from '~/ai/tools/bash/fs'
import { createVaultFileSystem } from '~/ai/tools/vault-filesystem'

describe('SkillRepository discovery, stale entries, and activation filtering', () => {
	it('skips a stale Vault Skill entry without hiding stable Skills or polluting Bash indexing', async () => {
		const mem = new MemoryVault({ name: 'StaleSkillVault' })
		const app = mem.app as unknown as App
		const adapter = app.vault.adapter
		const stableFolder = `${SKILLS_ROOT}/steady-skill`
		const stableSkill = `${stableFolder}/SKILL.md`
		const looseFile = `${SKILLS_ROOT}/中性文件🌱.md`
		const staleFolder = `${SKILLS_ROOT}/temporary-中性-🌱`
		const staleSkill = `${staleFolder}/SKILL.md`

		await adapter.mkdir(stableFolder)
		await adapter.write(
			stableSkill,
			'---\nname: steady-skill\ndescription: Neutral Skill / 中性技能 🌱\n---\n',
		)
		await adapter.write(looseFile, 'neutral loose file / 中性普通文件 🌱')

		const originalList = adapter.list.bind(adapter)
		const originalStat = adapter.stat.bind(adapter)
		adapter.list = async (path) => {
			const listed = await originalList(path)
			return path === SKILLS_ROOT
				? { ...listed, folders: [...listed.folders, staleFolder] }
				: listed
		}
		adapter.stat = async (path) => {
			if (path === staleFolder || path === staleSkill) {
				throw new Error(`ENOENT: neutral unavailable entry '${path}'`)
			}
			return originalStat(path)
		}

		const repository = new SkillRepository(app, [])
		await repository.refresh()

		expect(repository.getCatalog().map((skill) => skill.name)).toEqual([
			'steady-skill',
		])
		expect(
			repository
				.discover()
				.diagnostics.some((diagnostic) => diagnostic.path === staleSkill),
		).toBe(true)

		const fs = new ObsidianVaultFs(app)
		const entries = await fs.readdir(`/${SKILLS_ROOT}`)
		expect(entries).toContain('steady-skill')
		expect(entries).toContain('中性文件🌱.md')
		expect(entries).not.toContain('temporary-中性-🌱')

		const indexedFs = await createVaultFileSystem(app)
		expect(indexedFs.getAllPaths()).not.toContain(`/${staleFolder}`)
	})

	it('hides disabled Vault Skills while keeping built-in Skills active and supporting same-name overrides', async () => {
		const mem = new MemoryVault({ name: 'DisabledSkillVault' })
		const app = mem.app as unknown as App
		const adapter = app.vault.adapter
		const builtinName = BUILTIN_SKILLS[0]?.name
		expect(builtinName).toBeDefined()

		const activeFolder = `${SKILLS_ROOT}/active-skill`
		const hiddenFolder = `${SKILLS_ROOT}/hidden-skill`
		const overrideFolder = `${SKILLS_ROOT}/${builtinName!}`
		const disabled = new Set(['hidden-skill', builtinName!])

		await adapter.mkdir(activeFolder)
		await adapter.mkdir(hiddenFolder)
		await adapter.write(
			`${activeFolder}/SKILL.md`,
			'---\nname: active-skill\ndescription: Neutral active Skill / 中性启用技能 🌱\n---\n',
		)
		await adapter.write(
			`${hiddenFolder}/SKILL.md`,
			'---\nname: hidden-skill\ndescription: Neutral hidden Skill / 中性停用技能 🌱\n---\n',
		)

		const repository = new SkillRepository(app, BUILTIN_SKILLS, (name) =>
			disabled.has(name),
		)
		await repository.refresh()

		const catalog = repository.getCatalog().map((skill) => skill.name)
		expect(catalog).toContain(builtinName!)
		expect(catalog).toContain('active-skill')
		expect(catalog).not.toContain('hidden-skill')
		expect(
			repository
				.discover()
				.skills.some((skill) => skill.name === 'hidden-skill'),
		).toBe(true)

		disabled.delete('hidden-skill')
		expect(
			repository.getCatalog().find((skill) => skill.name === 'hidden-skill')
				?.description,
		).toBe('Neutral hidden Skill / 中性停用技能 🌱')

		disabled.add('active-skill')
		expect(
			repository.getCatalog().some((skill) => skill.name === 'active-skill'),
		).toBe(false)

		await adapter.mkdir(overrideFolder)
		await adapter.write(
			`${overrideFolder}/SKILL.md`,
			`---\nname: ${builtinName!}\ndescription: Neutral override / 中性覆盖 🌱\n---\n`,
		)
		await repository.refresh()

		expect(
			repository
				.discoverConfigurable()
				.skills.find((skill) => skill.name === builtinName!)?.description,
		).toBe('Neutral override / 中性覆盖 🌱')
		expect(
			repository.getCatalog().some((skill) => skill.name === builtinName!),
		).toBe(false)

		disabled.delete(builtinName!)
		expect(
			repository.getCatalog().find((skill) => skill.name === builtinName!)
				?.description,
		).toBe('Neutral override / 中性覆盖 🌱')
	})
})

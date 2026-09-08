import type { App } from 'obsidian'
import { assert } from './assert'

const E2E_ROOT = '.agents/nutstore-sync/e2e'

export async function roundTripsVaultAdapterContent(app: App) {
	const path = `${E2E_ROOT}/中性 sample 🌱.txt`
	const content = 'neutral content / 中性内容 🌱'
	await app.vault.adapter.mkdir(E2E_ROOT)
	await app.vault.adapter.write(path, content)
	assert(
		(await app.vault.adapter.read(path)) === content,
		'Vault adapter did not round-trip Unicode content',
	)
	await app.vault.adapter.remove(path)
	assert(
		!(await app.vault.adapter.exists(path)),
		'Vault adapter did not remove its test file',
	)
}

export async function preservesBashHeredocUtf8(app: App) {
	const { execVaultBash } = await import('~/ai/tools/bash/runtime')
	const path = `${E2E_ROOT}/中性 heredoc 🌱.md`
	const content = [
		'---',
		'tags:',
		'  - 中性标签 🌱',
		'---',
		'',
		'# 中性标题',
		'',
		'正文：中文、English、Emoji 🛠️',
	].join('\n')
	const result = await execVaultBash(
		app,
		[`cat > "/${path}" << 'ENDOFFILE'`, content, 'ENDOFFILE'].join('\n'),
	)
	assert(result.exitCode === 0, 'Bash heredoc write failed')
	const bytes = await app.vault.adapter.readBinary(path)
	assert(
		new TextDecoder().decode(bytes) === `${content}\n`,
		'Bash heredoc write did not preserve UTF-8 content',
	)
	// The MSB guest is disposable; keep the file available for failure
	// diagnostics instead of racing Obsidian's external-file watcher.
}

export async function expandsExistingVaultPathsInBash(app: App) {
	const { createVaultFileSystem } = await import('~/ai/tools/vault-filesystem')
	const { createVaultBash } = await import('~/ai/tools/bash/runtime')
	const { ReversibleOpRecorder } = await import('~/ai/tools/bash/fs')
	const path = '中性通配 🌱.md'
	await app.vault.create(path, 'neutral wildcard content / 中性通配内容 🌱')
	const filesystem = await createVaultFileSystem(app)
	assert(
		filesystem.getAllPaths().includes(`/${path}`),
		'New Vault filesystem did not index an existing Vault path',
	)

	const bash = await createVaultBash(app, undefined, new ReversibleOpRecorder())
	assert(
		bash.fs.getAllPaths().includes(`/${path}`),
		'Bash filesystem did not index an existing Vault path',
	)
	const result = await bash.exec('ls *.md', { cwd: '/' })
	assert(
		result.exitCode === 0,
		`Bash did not expand an existing Vault path: ${result.stderr}`,
	)
}

export async function excludesUnrelatedHiddenPathsFromGlobSnapshot(app: App) {
	const { createVaultFileSystem } = await import('~/ai/tools/vault-filesystem')
	const hiddenDir = '.隐藏样例 🌱'
	const hiddenPath = `${hiddenDir}/中性样例 🌱.md`
	await app.vault.adapter.mkdir(hiddenDir)
	await app.vault.adapter.write(
		hiddenPath,
		'neutral hidden content / 中性隐藏内容 🌱',
	)
	try {
		const filesystem = await createVaultFileSystem(app)
		assert(
			!filesystem.getAllPaths().includes(`/${hiddenPath}`),
			'Glob snapshot should exclude hidden paths outside the plugin domain',
		)
	} finally {
		await app.vault.adapter.remove(hiddenPath)
		await app.vault.adapter.rmdir(hiddenDir, true)
	}
}

export async function expandsAgentDomainPathsInBash(app: App) {
	const { createVaultFileSystem } = await import('~/ai/tools/vault-filesystem')
	const { createVaultBash } = await import('~/ai/tools/bash/runtime')
	const { ReversibleOpRecorder } = await import('~/ai/tools/bash/fs')
	const skillDir = '.agents/skills/中性技能 🌱'
	const skillPath = `${skillDir}/SKILL.md`
	await app.vault.adapter.mkdir(skillDir)
	await app.vault.adapter.write(
		skillPath,
		'neutral skill content / 中性技能内容 🌱',
	)
	try {
		const filesystem = await createVaultFileSystem(app)
		assert(
			filesystem.getAllPaths().includes(`/${skillPath}`),
			'Glob snapshot did not index the plugin agent domain directory',
		)

		const bash = await createVaultBash(
			app,
			undefined,
			new ReversibleOpRecorder(),
		)
		const result = await bash.exec('ls /.agents/skills/*/SKILL.md', {
			cwd: '/',
		})
		assert(
			result.exitCode === 0 && result.stdout.includes('SKILL.md'),
			`Bash did not expand plugin agent domain paths: exit=${result.exitCode} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
		)
	} finally {
		await app.vault.adapter.remove(skillPath)
		await app.vault.adapter.rmdir(skillDir, true)
	}
}

export async function resolvesResourceDataUrls(app: App) {
	const { resolveResourceDataUrl } =
		await import('~/ai/tools/resource-data-url')
	const path = `${E2E_ROOT}/中性 resource 🌱.txt`
	const content = 'neutral resource / 中性资源 🌱'
	await app.vault.adapter.write(path, content)
	try {
		const result = await resolveResourceDataUrl(app, `/${path}`, 'text/plain')
		assert(result, 'Resource data URL was not resolved from the Vault')
		const encoded = result.slice(result.indexOf(',') + 1)
		const bytes = Uint8Array.from(atob(encoded), (character) =>
			character.charCodeAt(0),
		)
		assert(
			new TextDecoder().decode(bytes) === content,
			'Resource data URL did not preserve Unicode content',
		)
	} finally {
		await app.vault.adapter.remove(path)
	}
}

export async function skipsStaleVaultSkillEntries(app: App) {
	const { SkillRepository, SKILLS_ROOT } =
		await import('~/ai/skills/repository')
	const { ObsidianVaultFs } = await import('~/ai/tools/bash/fs')
	const { createVaultFileSystem } = await import('~/ai/tools/vault-filesystem')
	const adapter = app.vault.adapter
	const stableFolder = `${SKILLS_ROOT}/steady-skill`
	const stableSkill = `${stableFolder}/SKILL.md`
	const looseFile = `${SKILLS_ROOT}/中性文件🌱.md`
	const staleFolder = `${SKILLS_ROOT}/temporary-中性-🌱`
	const staleSkill = `${staleFolder}/SKILL.md`

	if (!(await adapter.exists(SKILLS_ROOT))) await adapter.mkdir(SKILLS_ROOT)
	await adapter.mkdir(stableFolder)
	await adapter.write(
		stableSkill,
		'---\nname: steady-skill\ndescription: Neutral Skill / 中性技能 🌱\n---\n',
	)
	await adapter.write(looseFile, 'neutral loose file / 中性普通文件 🌱')

	const originalList = adapter.list
	const originalStat = adapter.stat
	adapter.list = async (path) => {
		const listed = await originalList.call(adapter, path)
		return path === SKILLS_ROOT
			? { ...listed, folders: [...listed.folders, staleFolder] }
			: listed
	}
	adapter.stat = async (path) => {
		if (path === staleFolder || path === staleSkill) {
			throw new Error(`ENOENT: neutral unavailable entry '${path}'`)
		}
		return originalStat.call(adapter, path)
	}

	try {
		const repository = new SkillRepository(app, [])
		await repository.refresh()
		assert(
			repository.getCatalog().length === 1 &&
				repository.getCatalog()[0].name === 'steady-skill',
			'Stable Vault Skill was not discovered',
		)
		assert(
			repository
				.discover()
				.diagnostics.some((diagnostic) => diagnostic.path === staleSkill),
			'Stale Vault Skill did not produce a diagnostic',
		)

		const fs = new ObsidianVaultFs(app)
		const entries = await fs.readdir(`/${SKILLS_ROOT}`)
		assert(
			entries.includes('steady-skill') && entries.includes('中性文件🌱.md'),
			'Stable Skill entries were hidden from Bash',
		)
		assert(
			!entries.includes('temporary-中性-🌱'),
			'Stale Skill entry was exposed to Bash',
		)

		const indexedFs = await createVaultFileSystem(app)
		assert(
			!indexedFs.getAllPaths().includes(`/${staleFolder}`),
			'Stale adapter entry was added to the initial Bash glob index',
		)
	} finally {
		adapter.list = originalList
		adapter.stat = originalStat
	}
}

export async function respectsVaultDeletionPreference(app: App) {
	const { ObsidianVaultFs } = await import('~/ai/tools/bash/fs')
	const { removeLocalPath } = await import('~/utils/local-vault-io')
	const fs = new ObsidianVaultFs(app)
	const paths = ['Neutral removal.md', '中性删除.md', 'Removal 删除 🌱.md']
	const originalTrash = app.fileManager.trashFile
	const calls: string[] = []
	app.fileManager.trashFile = async (file) => {
		calls.push(file.path)
		await originalTrash.call(app.fileManager, file)
	}
	try {
		for (const [index, path] of paths.entries()) {
			await app.vault.create(path, 'Neutral content 中性内容 🌱')
			if (index === 0) await removeLocalPath(app, path)
			else await fs.rm(`/${path}`)
			assert(
				!app.vault.getAbstractFileByPath(path),
				'Deleted file remains in the Vault index',
			)
		}
		assert(
			JSON.stringify(calls) === JSON.stringify(paths),
			'Deletion bypassed FileManager preferences',
		)

		const retainedPath = 'Retained 保留 🌱.md'
		await app.vault.create(
			retainedPath,
			'Neutral retained content 中性保留内容 🌱',
		)
		app.fileManager.trashFile = () =>
			Promise.reject(new Error('Neutral deletion failure'))
		let rejected = false
		try {
			await fs.rm(`/${retainedPath}`)
		} catch {
			rejected = true
		}
		assert(
			rejected && !!app.vault.getAbstractFileByPath(retainedPath),
			'Failed trash silently fell back to permanent deletion',
		)
	} finally {
		app.fileManager.trashFile = originalTrash
	}
}

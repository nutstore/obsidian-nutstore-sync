import type { App } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'
import { MemoryVault } from '@test/harness/memory-vault'
import {
	APP_DATA_FILE,
	APP_MANIFEST_FILE,
	appDirectoryPath,
} from '~/ai/apps/paths'
import { ObsidianVaultFs, ReversibleOpRecorder } from '~/ai/tools/bash/fs'
import { createVaultBash, execVaultBash } from '~/ai/tools/bash/runtime'
import { resolveResourceDataUrl } from '~/ai/tools/resource-data-url'
import {
	createVaultFileSystem,
	VaultFileSystemManager,
} from '~/ai/tools/vault-filesystem'
import { removeLocalPath } from '~/utils/local-vault-io'

const BASE_ROOT = '.agents/nutstore-sync/tests'

describe('Vault Bash, filesystem snapshot, resource data URL, and deletion preference', () => {
	it('preserves UTF-8 CJK and Emoji content when Bash writes through a heredoc', async () => {
		const mem = new MemoryVault({ name: 'BashHeredocVault' })
		const app = mem.app as unknown as App
		const path = `${BASE_ROOT}/中性 heredoc 🌱.md`
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

		expect(result.exitCode).toBe(0)
		const bytes = await app.vault.adapter.readBinary(path)
		expect(new TextDecoder().decode(bytes)).toBe(`${content}\n`)
	})

	it('expands existing Vault paths and plugin agent domain paths while excluding unrelated hidden folders', async () => {
		const mem = new MemoryVault({ name: 'BashGlobVault' })
		const app = mem.app as unknown as App
		const notePath = '中性通配 🌱.md'
		const hiddenDir = '.隐藏样例 🌱'
		const hiddenPath = `${hiddenDir}/中性样例 🌱.md`
		const skillDir = '.agents/skills/中性技能 🌱'
		const skillPath = `${skillDir}/SKILL.md`

		await app.vault.create(
			notePath,
			'neutral wildcard content / 中性通配内容 🌱',
		)
		await app.vault.adapter.mkdir(hiddenDir)
		await app.vault.adapter.write(
			hiddenPath,
			'neutral hidden content / 中性隐藏内容 🌱',
		)
		await app.vault.adapter.mkdir(skillDir)
		await app.vault.adapter.write(
			skillPath,
			'neutral skill content / 中性技能内容 🌱',
		)

		const filesystem = await createVaultFileSystem(app)
		const indexed = filesystem.getAllPaths()
		expect(indexed).toContain(`/${notePath}`)
		expect(indexed).toContain(`/${skillPath}`)
		expect(indexed).not.toContain(`/${hiddenPath}`)

		const bash = await createVaultBash(
			app,
			undefined,
			new ReversibleOpRecorder(),
		)
		const noteLs = await bash.exec('ls *.md', { cwd: '/' })
		expect(noteLs.exitCode).toBe(0)
		expect(noteLs.stdout).toContain(notePath)

		const skillLs = await bash.exec('ls /.agents/skills/*/SKILL.md', {
			cwd: '/',
		})
		expect(skillLs.exitCode).toBe(0)
		expect(skillLs.stdout).toContain('SKILL.md')
	})

	it('resolves Vault resource data URLs while preserving UTF-8 CJK and Emoji bytes', async () => {
		const mem = new MemoryVault({ name: 'ResourceUrlVault' })
		const app = mem.app as unknown as App
		const path = `${BASE_ROOT}/中性 resource 🌱.txt`
		const content = 'neutral resource / 中性资源 🌱'
		await app.vault.adapter.write(path, content)

		const dataUrl = await resolveResourceDataUrl(app, `/${path}`, 'text/plain')
		expect(dataUrl).toBeDefined()
		const encoded = dataUrl!.slice(dataUrl!.indexOf(',') + 1)
		const bytes = Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0))
		expect(new TextDecoder().decode(bytes)).toBe(content)
	})

	it('respects FileManager deletion preferences without falling back to permanent deletion', async () => {
		const mem = new MemoryVault({ name: 'DeletionPrefVault' })
		const app = mem.app as unknown as App
		const fs = new ObsidianVaultFs(app)
		const paths = ['Neutral removal.md', '中性删除.md', 'Removal 删除 🌱.md']
		const trashed: string[] = []
		const originalTrash = app.fileManager.trashFile.bind(app.fileManager)
		app.fileManager.trashFile = vi.fn(async (file) => {
			trashed.push(file.path)
			await originalTrash(file)
		})

		for (const [index, path] of paths.entries()) {
			await app.vault.create(path, 'Neutral content 中性内容 🌱')
			if (index === 0) await removeLocalPath(app, path)
			else await fs.rm(`/${path}`)
			expect(app.vault.getAbstractFileByPath(path)).toBeNull()
		}
		expect(trashed).toEqual(paths)

		const retainedPath = 'Retained 保留 🌱.md'
		await app.vault.create(
			retainedPath,
			'Neutral retained content 中性保留内容 🌱',
		)
		app.fileManager.trashFile = vi.fn(() =>
			Promise.reject(new Error('Neutral deletion failure')),
		)

		await expect(fs.rm(`/${retainedPath}`)).rejects.toThrow()
		expect(app.vault.getAbstractFileByPath(retainedPath)).not.toBeNull()
	})

	it('blocks Bash writes to host-owned App data and blocks uninstall without lifecycle', async () => {
		const mem = new MemoryVault({ name: 'AppGuardVault' })
		const app = mem.app as unknown as App
		const appId = 'org.example.guarded'
		const dir = appDirectoryPath(appId)
		const dataPath = `${dir}/${APP_DATA_FILE}`
		const manifestPath = `${dir}/${APP_MANIFEST_FILE}`
		const originalData = JSON.stringify({ schemaVersion: 1, kv: { count: 2 } })
		await app.vault.adapter.mkdir(dir)
		await app.vault.adapter.write(dataPath, originalData)
		await app.vault.adapter.write(
			manifestPath,
			JSON.stringify({ schemaVersion: 1, title: '守护应用 Guarded App 🌿' }),
		)

		const manager = new VaultFileSystemManager(app)
		await expect(
			execVaultBash(app, `echo tampered > /${dataPath}`, {
				fileSystemManager: manager,
			}),
		).rejects.toThrow(/EROFS.*read-only/i)
		expect(await app.vault.adapter.read(dataPath)).toBe(originalData)

		const uninstall = await execVaultBash(app, `rm -r /${dir}`, {
			fileSystemManager: manager,
		})
		expect(uninstall.exitCode).not.toBe(0)
		expect(`${uninstall.stdout}${uninstall.stderr}`).toMatch(
			/ENOTSUP: App lifecycle is unavailable/,
		)
		expect(await app.vault.adapter.exists(manifestPath)).toBe(true)
	})
})

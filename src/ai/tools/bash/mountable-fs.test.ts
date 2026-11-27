import { Bash, InMemoryFs } from 'just-bash/browser'
import { describe, expect, it, vi } from 'vitest'
import { decodeReversibleFileSnapshot } from '~/ai/chat/messages/reversible-content'
import { ReversibleOpRecorder } from './fs'
import { MountableFs } from './mountable-fs'
import { ReversibleFs } from './reversible-fs'

describe('mounted directory enumeration', () => {
	it('rejects non-POSIX path aliases before any filesystem routing', async () => {
		const base = new InMemoryFs({
			'/Workspace 工作区 🌿/notes.md': 'Notes 笔记 🌱',
		})
		const mounted = new InMemoryFs()
		const fs = new MountableFs({
			base,
			mounts: [
				{ mountPoint: '/Workspace 工作区 🌿/apps', filesystem: mounted },
			],
		})
		const alias = '/Workspace 工作区 🌿\\apps'

		await expect(fs.exists(alias)).rejects.toThrow(/EINVAL/)
		await expect(
			fs.writeFile(alias, '中性内容 Neutral content 🌿'),
		).rejects.toThrow(/EINVAL/)
		await expect(fs.rm(alias, { recursive: true })).rejects.toThrow(/EINVAL/)
		await expect(fs.mv(alias, '/Archive 归档 🌿')).rejects.toThrow(/EINVAL/)
		expect(await base.readFile('/Workspace 工作区 🌿/notes.md')).toBe(
			'Notes 笔记 🌱',
		)
		expect(await mounted.readdir('/')).toEqual([])
	})

	it('canonicalizes Unicode before resolving mount protection', async () => {
		const base = new InMemoryFs()
		const mounted = new InMemoryFs({
			'/Notes 笔记 🧭.md': '中性笔记 Neutral note 🌱',
		})
		const fs = new MountableFs({
			base,
			mounts: [
				{
					mountPoint: '/Cafe\u0301 咖啡馆 🌿/apps',
					filesystem: mounted,
				},
			],
		})

		expect(
			await fs.readFile('/Caf\u00e9 咖啡馆 🌿/apps/Notes 笔记 🧭.md'),
		).toBe('中性笔记 Neutral note 🌱')
		await expect(
			fs.rm('/Cafe\u0301 咖啡馆 🌿', { recursive: true }),
		).rejects.toThrow(/EBUSY/)
		await expect(base.exists('/Cafe\u0301 咖啡馆 🌿')).resolves.toBe(false)
	})

	it('protects mount ancestors and rejects cross-mount moves before mutation', async () => {
		const base = new InMemoryFs({ '/Domain 领域 🌿/notes.md': 'Notes 笔记 🌿' })
		const mounted = new InMemoryFs({
			'/org.example.tool/index.html': 'Tool 工具 🌿',
		})
		const fs = new MountableFs({
			base,
			mounts: [{ mountPoint: '/Domain 领域 🌿/apps', filesystem: mounted }],
		})
		for (const path of [
			'/',
			'/Domain 领域 🌿',
			'/Domain 领域 🌿/apps',
			'/Domain 领域 🌿/apps/..',
		]) {
			await expect(fs.rm(path, { recursive: true })).rejects.toThrow(/EBUSY/)
			await expect(fs.mv(path, '/Archive 归档 🌿')).rejects.toThrow(/EBUSY/)
		}
		await expect(
			fs.mv('/Domain 领域 🌿/apps/org.example.tool', '/Archive 归档 🌿'),
		).rejects.toThrow(/EXDEV/)
		expect(await mounted.readFile('/org.example.tool/index.html')).toBe(
			'Tool 工具 🌿',
		)
		expect(await base.exists('/Archive 归档 🌿')).toBe(false)
	})

	it('expands vault and mounted Skill globs through reversible Bash', async () => {
		const base = new InMemoryFs({
			'/Weekly review 每周复盘 🌱.md': 'Neutral notes / 中性笔记 🌱',
		})
		const skills = new InMemoryFs({
			'/writing-guide/SKILL.md': 'Neutral guide / 中性指南 🧭',
		})
		const fs = new ReversibleFs(
			new MountableFs({
				base,
				mounts: [{ mountPoint: '/.agents/skills', filesystem: skills }],
			}),
			new ReversibleOpRecorder(),
		)
		const bash = new Bash({ fs, cwd: '/' })
		const result = await bash.exec('ls *.md /.agents/skills/*/SKILL.md')
		expect(result.exitCode).toBe(0)
		expect(result.stderr).toBe('')
		expect(result.stdout).toContain('Weekly review 每周复盘 🌱.md')
		expect(result.stdout).toContain('/.agents/skills/writing-guide/SKILL.md')
	})

	it('preserves symlink types and gives a mount precedence over a base entry', async () => {
		const base = new InMemoryFs({
			'/Guide 指南 🧭.md': 'Neutral guide / 中性指南 🧭',
			'/Resources 资源 📚': 'Neutral placeholder / 中性占位内容 📚',
		})
		await base.symlink('/Guide 指南 🧭.md', '/Guide link 指南链接 🔗')
		const fs = new MountableFs({
			base,
			mounts: [
				{ mountPoint: '/Resources 资源 📚', filesystem: new InMemoryFs() },
			],
		})
		const entries = await fs.readdirWithFileTypes('/')
		expect(entries).toEqual([
			{
				name: 'Guide link 指南链接 🔗',
				isFile: false,
				isDirectory: false,
				isSymbolicLink: true,
			},
			{
				name: 'Guide 指南 🧭.md',
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
			},
			{
				name: 'Resources 资源 📚',
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
			},
		])
	})

	it('delegates readdirWithFileTypes natively without per-entry lstat calls', async () => {
		const base = new InMemoryFs({
			'/笔记 Notes 🌱/条目一.md': '中性内容 Neutral entry 🌱',
			'/笔记 Notes 🌱/子目录 Sub 📁/条目二.md': '次级内容 Secondary 🌿',
		})
		const mounted = new InMemoryFs({
			'/清单.md': '挂载内容 Mounted 🧭',
		})
		const baseLstatSpy = vi.spyOn(base, 'lstat')
		const mountLstatSpy = vi.spyOn(mounted, 'lstat')
		const fs = new MountableFs({
			base,
			mounts: [
				{
					mountPoint: '/.config/空间 Space 🧭',
					filesystem: mounted,
				},
			],
		})

		const noteEntries = await fs.readdirWithFileTypes('/笔记 Notes 🌱')
		expect(noteEntries).toEqual([
			{
				name: '子目录 Sub 📁',
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
			},
			{
				name: '条目一.md',
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
			},
		])
		// Virtual ancestor directories not present in base still surface child mounts.
		expect(await fs.readdirWithFileTypes('/.config')).toEqual([
			{
				name: '空间 Space 🧭',
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
			},
		])
		expect(await fs.readdirWithFileTypes('/.config/空间 Space 🧭')).toEqual([
			{
				name: '清单.md',
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
			},
		])
		expect(baseLstatSpy).not.toHaveBeenCalled()
		expect(mountLstatSpy).not.toHaveBeenCalled()
	})

	it('rejects moving or copying a directory into itself on both base and mounts', async () => {
		const base = new InMemoryFs({
			'/工作区 Workspace 🌿/文档.md': '基础文档 Base doc 🌱',
		})
		const mounted = new InMemoryFs({
			'/项目 Project 🧩/入口.md': '挂载文档 Mounted doc 🧭',
		})
		const fs = new MountableFs({
			base,
			mounts: [{ mountPoint: '/.agents/apps', filesystem: mounted }],
		})

		await expect(
			fs.mv('/工作区 Workspace 🌿', '/工作区 Workspace 🌿/嵌套 Nested'),
		).rejects.toThrow(/EINVAL/)
		await expect(
			fs.mv(
				'/.agents/apps/项目 Project 🧩',
				'/.agents/apps/项目 Project 🧩/子项',
			),
		).rejects.toThrow(/EINVAL/)
		await expect(
			fs.cp(
				'/.agents/apps/项目 Project 🧩',
				'/.agents/apps/项目 Project 🧩/副本',
				{
					recursive: true,
				},
			),
		).rejects.toThrow(/EINVAL/)
	})

	it('copies trees across mounts without invoking destination chmod', async () => {
		const base = new InMemoryFs()
		const mounted = new InMemoryFs({
			'/章节 Chapter 📖/说明🌱.md': '跨挂载内容 Cross-mount content 🌿',
		})
		const baseChmodSpy = vi.spyOn(base, 'chmod')
		const fs = new MountableFs({
			base,
			mounts: [{ mountPoint: '/.agents/skills', filesystem: mounted }],
		})

		await fs.cp('/.agents/skills/章节 Chapter 📖', '/导出 Export 📦', {
			recursive: true,
		})

		expect(await base.readFile('/导出 Export 📦/说明🌱.md')).toBe(
			'跨挂载内容 Cross-mount content 🌿',
		)
		expect(baseChmodSpy).not.toHaveBeenCalled()
	})

	it('reuses verbatim write bytes in ReversibleFs while reading back transforming mounts', async () => {
		const base = new InMemoryFs({
			'/草稿 Draft 🌱.md': '初始文本 Initial text 🌱',
		})
		const transformingInner = new InMemoryFs({
			'/config.json': '{"mode":"a"}\n',
		})
		const transformingFs = Object.assign(
			Object.create(transformingInner) as InMemoryFs,
			{
				transformsWritesAt: () => true,
				async writeFile(path: string, content: string | Uint8Array) {
					const raw =
						typeof content === 'string'
							? content
							: new TextDecoder('utf-8').decode(content)
					const parsed = JSON.parse(raw) as Record<string, unknown>
					await transformingInner.writeFile(
						path,
						`${JSON.stringify({ ...parsed, normalized: '已规范化 🧭' })}\n`,
					)
				},
			},
		)
		const baseReadSpy = vi.spyOn(base, 'readFileBuffer')
		const baseExistsSpy = vi.spyOn(base, 'exists')
		const mountReadSpy = vi.spyOn(transformingInner, 'readFileBuffer')

		const recorder = new ReversibleOpRecorder()
		const mountable = new MountableFs({
			base,
			mounts: [{ mountPoint: '/.config/demo', filesystem: transformingFs }],
		})
		const fs = new ReversibleFs(mountable, recorder, {
			absoluteMountPoints: ['/.config/demo'],
		})

		// Updating an existing verbatim file reads only once for `before` and skips
		// both parent `exists` probing and post-write read-back.
		await fs.writeFile('/草稿 Draft 🌱.md', '更新文本 Updated text 🌿')
		expect(baseReadSpy).toHaveBeenCalledTimes(1)
		expect(baseExistsSpy).not.toHaveBeenCalled()

		// Updating a second time in the same turn already has `before`, so zero reads.
		await fs.writeFile('/草稿 Draft 🌱.md', '最终文本 Final text 🚀')
		expect(baseReadSpy).toHaveBeenCalledTimes(1)

		// Creating a file in a brand-new nested folder records both parents and file
		// without post-write reads.
		await fs.writeFile(
			'/新建目录 New 📁/子层 Sub/文档🌱.md',
			'新建正文 New body 🌱',
		)
		expect(baseReadSpy).toHaveBeenCalledTimes(1)

		// Writing to a transforming mount must read back the normalized bytes.
		await fs.writeFile('/.config/demo/config.json', '{"mode":"b"}')
		expect(mountReadSpy).toHaveBeenCalledTimes(2)

		const ops = await recorder.getNetOperations()
		const updatedDraft = ops.find(
			(op) => op.operation === 'update' && op.vaultPath === '草稿 Draft 🌱.md',
		)
		const createdNestedDir = ops.find(
			(op) => op.operation === 'create' && op.vaultPath === '新建目录 New 📁',
		)
		const createdSubDir = ops.find(
			(op) =>
				op.operation === 'create' &&
				op.vaultPath === '新建目录 New 📁/子层 Sub',
		)
		const createdNestedFile = ops.find(
			(op) =>
				op.operation === 'create' &&
				op.vaultPath === '新建目录 New 📁/子层 Sub/文档🌱.md',
		)
		const updatedConfig = ops.find(
			(op) =>
				op.operation === 'update' &&
				op.vaultPath === '/.config/demo/config.json',
		)

		expect(createdNestedDir?.operation).toBe('create')
		expect(createdSubDir?.operation).toBe('create')
		expect(createdNestedFile?.operation).toBe('create')
		expect(updatedDraft?.operation).toBe('update')
		expect(updatedConfig?.operation).toBe('update')

		const decoder = new TextDecoder('utf-8')
		if (createdNestedDir?.operation === 'create') {
			expect(createdNestedDir.after).toEqual({ kind: 'dir' })
		}
		if (createdSubDir?.operation === 'create') {
			expect(createdSubDir.after).toEqual({ kind: 'dir' })
		}
		if (
			createdNestedFile?.operation === 'create' &&
			createdNestedFile.after?.kind === 'file'
		) {
			expect(
				decoder.decode(
					await decodeReversibleFileSnapshot(createdNestedFile.after),
				),
			).toBe('新建正文 New body 🌱')
		}
		if (updatedDraft?.operation === 'update' && updatedDraft.after) {
			expect(
				decoder.decode(await decodeReversibleFileSnapshot(updatedDraft.before)),
			).toBe('初始文本 Initial text 🌱')
			expect(
				decoder.decode(await decodeReversibleFileSnapshot(updatedDraft.after)),
			).toBe('最终文本 Final text 🚀')
		}
		if (updatedConfig?.operation === 'update' && updatedConfig.after) {
			expect(
				decoder.decode(await decodeReversibleFileSnapshot(updatedConfig.after)),
			).toBe('{"mode":"b","normalized":"已规范化 🧭"}\n')
		}
	})
})

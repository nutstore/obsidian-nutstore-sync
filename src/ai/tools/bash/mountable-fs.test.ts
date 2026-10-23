import { Bash, InMemoryFs } from 'just-bash/browser'
import { describe, expect, it } from 'vitest'
import { ReversibleOpRecorder } from './fs'
import { MountableFs } from './mountable-fs'
import { ReversibleFs } from './reversible-fs'

describe('mounted directory enumeration', () => {
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
})

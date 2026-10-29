import { InMemoryFs } from 'just-bash/browser'
import type { App } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'
import { MountableFs } from '~/ai/tools/bash/mountable-fs'
import { AppFs } from './fs'
import { APP_ROOT_DIR, appDirectoryPath } from './paths'

vi.mock('obsidian', () => ({
	normalizePath: (path: string) =>
		path
			.normalize('NFC')
			.replace(/\\/g, '/')
			.replace(/\u00a0|\u202f/g, ' ')
			.replace(/\/+/g, '/')
			.replace(/^\/+|\/+$/g, ''),
	TFile: class {},
	TFolder: class {},
}))

function fixture(readonlyApps = false) {
	const disk = new InMemoryFs()
	const adapter = {
		exists: (path: string) => disk.exists(`/${path}`),
		mkdir: (path: string) => disk.mkdir(`/${path}`, { recursive: true }),
		writeBinary: (path: string, bytes: ArrayBuffer) =>
			disk.writeFile(`/${path}`, new Uint8Array(bytes)),
		readBinary: async (path: string) =>
			(await disk.readFileBuffer(`/${path}`)).slice().buffer,
		stat: async (path: string) => {
			if (!(await disk.exists(`/${path}`))) return null
			const stat = await disk.stat(`/${path}`)
			return {
				type: stat.isDirectory ? 'folder' : 'file',
				size: stat.size,
				mtime: 0,
			}
		},
		list: async (path: string) => {
			const files: string[] = [],
				folders: string[] = []
			for (const name of await disk.readdir(`/${path}`)) {
				const child = `${path}/${name}`
				;(await disk.stat(`/${child}`)).isDirectory
					? folders.push(child)
					: files.push(child)
			}
			return { files, folders }
		},
		rename: (src: string, dest: string) => disk.mv(`/${src}`, `/${dest}`),
		rmdir: (path: string, recursive: boolean) =>
			disk.rm(`/${path}`, { recursive }),
	}
	const app = {
		vault: {
			adapter,
			// App storage is rooted independently of Obsidian configuration.
			// Any accidental dependency must fail these filesystem operations.
			get configDir(): string {
				throw new Error('App mounts must not access vault configuration')
			},
		},
		fileManager: {},
	} as unknown as App
	const permissionGuard = vi.fn(async () => {})
	const onRead = vi.fn()
	const appLifecycle = {
		remove: async (id: string) => {
			await disk.rm(`/${appDirectoryPath(id)}`, { recursive: true })
		},
	}
	const fs = new MountableFs({
		base: new InMemoryFs(),
		mounts: [
			{
				mountPoint: `/${APP_ROOT_DIR}`,
				filesystem: new AppFs(
					app,
					{ appLifecycle, permissionGuard, readonlyApps },
					onRead,
				),
			},
		],
	})
	return { fs, disk, permissionGuard, onRead }
}

describe('App filesystem mount', () => {
	it('maps source IO to App storage and reports vault-relative reads', async () => {
		const { fs, disk, permissionGuard, onRead } = fixture()
		const path = `/${APP_ROOT_DIR}/org.example.notes/素材 Assets 🌿/记录 Notes.md`
		await fs.writeFile(path, '中性内容 Neutral content 🌿')
		expect(await disk.readFile(path)).toBe('中性内容 Neutral content 🌿')
		expect(await fs.readFile(path)).toBe('中性内容 Neutral content 🌿')
		expect(onRead).toHaveBeenCalledWith(path.slice(1))
		expect(await fs.readdir(`/${APP_ROOT_DIR}`)).toEqual(['org.example.notes'])
		await fs.mv(path, `${path}.archive`)
		expect(await fs.readFile(`${path}.archive`)).toBe(
			'中性内容 Neutral content 🌿',
		)
		expect(permissionGuard).not.toHaveBeenCalled()
		await fs.rm(`/${APP_ROOT_DIR}/org.example.notes`, { recursive: true })
		expect(permissionGuard).toHaveBeenCalledWith({
			type: 'fs',
			fs: { kind: 'delete', path: `/${APP_ROOT_DIR}/org.example.notes` },
		})
		expect(await disk.exists(path)).toBe(false)
	})

	it('protects host files and runtime source while retaining confirmed uninstall', async () => {
		const { fs, disk, permissionGuard } = fixture(true)
		const root = `/${APP_ROOT_DIR}/org.example.notes`
		await disk.mkdir(root, { recursive: true })
		await disk.writeFile(`${root}/data.json`, '{"记录 Record 🌿":1}')
		for (const file of [
			'data.json',
			'state.json',
			'logs.jsonl',
			'记录 Notes 🌿.md',
		]) {
			await expect(
				fs.writeFile(`${root}/${file}`, '中性内容 Neutral content 🌿'),
			).rejects.toThrow(/EROFS/)
			await expect(fs.rm(`${root}/${file}`)).rejects.toThrow(/EROFS/)
		}
		await expect(fs.rm(root)).rejects.toThrow(/EISDIR/)
		expect(permissionGuard).not.toHaveBeenCalled()
		await fs.rm(root, { recursive: true })
		expect(await disk.exists(root)).toBe(false)
		expect(permissionGuard).toHaveBeenCalledTimes(1)
	})
})

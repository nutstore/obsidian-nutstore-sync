import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
	APP_DATA_FILE,
	APP_LOG_FILE,
	APP_MANIFEST_FILE,
	APP_ROOT_DIR,
	APP_STATE_FILE,
	appDirectoryPath,
} from './paths'
import { emptyAppManifest } from './manifest'
import { newAppState } from './store'
import { MAX_VALUE_BYTES } from './capabilities/kv'
import { AppStore } from './store'
import { AppLifecycleQueue } from './lifecycle'
import { writeLocalTextAtomic } from '~/utils/local-vault-io'

const disk = vi.hoisted(() => new Map<string, string>())
const pathListeners = vi.hoisted(() => new Set<(path: string) => void>())
vi.mock('~/utils/mkdirs-vault', () => ({ mkdirsVault: async () => {} }))
vi.mock('~/utils/local-vault-io', () => {
	const emit = (path: string) => {
		for (const listener of pathListeners) listener(path)
	}
	return {
		onLocalPathChanged: (listener: (path: string) => void) => {
			pathListeners.add(listener)
			return () => pathListeners.delete(listener)
		},
		readLocalText: async (_vault: unknown, path: string) => {
			if (!disk.has(path)) throw new Error(`Missing file: ${path}`)
			return disk.get(path)!
		},
		writeLocalTextAtomic: async (
			_vault: unknown,
			path: string,
			content: string,
		) => {
			disk.set(path, content)
			emit(path)
		},
		removeLocalPath: async (_app: unknown, path: string) => {
			for (const key of [...disk.keys()])
				if (key === path || key.startsWith(`${path}/`)) disk.delete(key)
			emit(path)
		},
	}
})
function normalize(path: string) {
	return path.replace(/^\/+/, '').replace(/\/+$/, '')
}

/** The adapter only exposes existence and listing; all reads/writes go through local vault I/O. */
const adapter = {
	exists: async (path: string) => {
		const target = normalize(path)
		return (
			disk.has(target) ||
			[...disk.keys()].some((key) => key.startsWith(`${target}/`))
		)
	},
	list: async (path: string) => {
		const target = normalize(path)
		const prefix = target ? `${target}/` : ''
		const files: string[] = []
		const folders = new Set<string>()
		for (const key of disk.keys()) {
			if (!key.startsWith(prefix)) continue
			const rest = key.slice(prefix.length)
			const separator = rest.indexOf('/')
			if (separator < 0) files.push(key)
			else folders.add(`${prefix}${rest.slice(0, separator)}`)
		}
		return { files, folders: [...folders] }
	},
}
const app = {
	vault: { adapter, configDir: '.obsidian' },
	fileManager: {},
} as unknown as ConstructorParameters<typeof AppStore>[0]

function directory(id: string) {
	return appDirectoryPath(id)
}
function seedFile(path: string, content: string) {
	disk.set(path, content)
}
function seedApp(
	id = 'org.example.checklist',
	title = '中性清单 Neutral checklist 🌿',
) {
	const manifest = emptyAppManifest(title)
	const state = newAppState(1_000)
	seedFile(`${directory(id)}/${APP_MANIFEST_FILE}`, JSON.stringify(manifest))
	seedFile(`${directory(id)}/${APP_STATE_FILE}`, JSON.stringify(state))
	return { id, manifest, state }
}

let lifecycle: AppLifecycleQueue

beforeEach(() => {
	lifecycle = new AppLifecycleQueue()
	disk.clear()
	pathListeners.clear()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('App store over real vault directories', () => {
	it('creates an App directory with a manifest and host state as the only files', async () => {
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)

		expect(created.id).toBe('org.example.checklist')
		expect(created.manifest).toEqual(
			emptyAppManifest('中性清单 Neutral checklist 🌿'),
		)
		expect(created.state.pinned).toBe(false)
		expect(created.state.createdAt).toBe(created.state.updatedAt)
		expect(await store.exists(created.id)).toBe(true)
		expect(await store.read(created.id)).toEqual(created)

		const createdFiles = [...disk.keys()]
			.filter((path) => path.startsWith(`${directory(created.id)}/`))
			.map((path) => path.slice(directory(created.id).length + 1))
			.sort()
		expect(createdFiles).toEqual([APP_MANIFEST_FILE, APP_STATE_FILE])
		expect(
			JSON.parse(disk.get(`${directory(created.id)}/${APP_MANIFEST_FILE}`)!),
		).toEqual(created.manifest)
		expect(
			JSON.parse(disk.get(`${directory(created.id)}/${APP_STATE_FILE}`)!),
		).toEqual(created.state)
	})

	it('rejects a duplicate App identity without touching the existing directory', async () => {
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		const before = new Map(disk)

		await expect(
			store.create(created.id, '替换 Replacement 中文 🧭'),
		).rejects.toThrow(`App already exists: ${created.id}`)
		expect(disk).toEqual(before)
		expect(await store.read(created.id)).toEqual(created)
	})

	it.each([
		'app-123',
		'Counter',
		'org..counter',
		'org.example.1counter',
		'org.example.counter-name',
		'org.示例.counter',
		'org.example.🌿',
		'../org.example.counter',
	])('rejects invalid App identity %s', async (id) => {
		const store = new AppStore(app, lifecycle)
		await expect(store.create(id, '中性应用 Neutral app 🌿')).rejects.toThrow()
		expect(disk.size).toBe(0)
		await expect(store.read(id)).rejects.toThrow()
	})

	it.each([
		[
			'missing manifest',
			(id: string) => {
				disk.delete(`${directory(id)}/${APP_MANIFEST_FILE}`)
			},
			/Invalid App manifest/,
		],
		[
			'corrupt manifest JSON',
			(id: string) => {
				disk.set(`${directory(id)}/${APP_MANIFEST_FILE}`, '{"title":')
			},
			/Invalid App manifest/,
		],
		[
			'manifest with another schema version',
			(id: string) => {
				disk.set(
					`${directory(id)}/${APP_MANIFEST_FILE}`,
					JSON.stringify({
						schemaVersion: 2,
						title: '中性工具 Neutral tool 🌿',
						iconSvg: '<svg viewBox="0 0 100 100"/>',
						dataVersion: 1,
					}),
				)
			},
			/Invalid App manifest/,
		],
		[
			'manifest with an empty title',
			(id: string) => {
				disk.set(
					`${directory(id)}/${APP_MANIFEST_FILE}`,
					JSON.stringify({
						schemaVersion: 1,
						title: '',
						iconSvg: '<svg viewBox="0 0 100 100"/>',
						dataVersion: 1,
					}),
				)
			},
			/Invalid App manifest/,
		],
		[
			'corrupt state JSON',
			(id: string) => {
				disk.set(`${directory(id)}/${APP_STATE_FILE}`, '[]')
			},
			/Invalid App state/,
		],
	])('rejects read for a %s', async (_name, mutate, message) => {
		const fixture = seedApp()
		mutate(fixture.id)
		const store = new AppStore(app, lifecycle)
		await expect(store.read(fixture.id)).rejects.toThrow(message)
	})

	it('materializes host state for an App manifest created from files', async () => {
		const manifest = emptyAppManifest('由文件创建 Created from files 🌿')
		seedFile(
			`${APP_ROOT_DIR}/org.example.files/${APP_MANIFEST_FILE}`,
			JSON.stringify(manifest),
		)
		const store = new AppStore(app, lifecycle)

		const read = await store.read('org.example.files')

		expect(read.manifest).toEqual(manifest)
		expect(read.state.pinned).toBe(false)
		expect(read.state.createdAt).toBeGreaterThan(0)
		expect(
			disk.has(`${APP_ROOT_DIR}/org.example.files/${APP_STATE_FILE}`),
		).toBe(true)
		expect(await store.read('org.example.files')).toEqual(read)
	})

	it('lists only directories whose manifest makes them an App', async () => {
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		// A stray folder without a manifest is not an App.
		seedFile(
			`${APP_ROOT_DIR}/org.example.stray/notes.md`,
			'中性笔记 Neutral note 🌿',
		)
		// A manifest alone is a valid App: host state is materialized on first read.
		seedFile(
			`${APP_ROOT_DIR}/org.example.partial/${APP_MANIFEST_FILE}`,
			JSON.stringify(emptyAppManifest('未完成 Incomplete 🌿')),
		)
		// A corrupt manifest inside an App folder is reported, not thrown.
		seedFile(`${APP_ROOT_DIR}/org.example.broken/${APP_MANIFEST_FILE}`, '{')
		seedFile(
			`${APP_ROOT_DIR}/org.example.broken/${APP_STATE_FILE}`,
			JSON.stringify(newAppState(1_000)),
		)
		// Loose files directly under the root are ignored.
		seedFile(`${APP_ROOT_DIR}/README.md`, '中性说明 Neutral readme 🌿')

		const listed = await store.list()
		const byId = new Map(listed.map((item) => [item.id, item]))

		expect(byId.get(created.id)?.app).toEqual(created)
		expect(byId.has('org.example.stray')).toBe(false)
		expect(byId.has('README.md')).toBe(false)
		expect(byId.get('org.example.partial')?.app?.manifest.title).toBe(
			'未完成 Incomplete 🌿',
		)
		expect(byId.get('org.example.partial')?.error).toBeUndefined()
		expect(byId.get('org.example.broken')?.app).toBeUndefined()
		expect(byId.get('org.example.broken')?.error).toMatch(
			/Invalid App manifest/,
		)
	})

	it('returns an empty list before any App directory exists', async () => {
		expect(await new AppStore(app, lifecycle).list()).toEqual([])
	})

	it('persists pinned host state and advances only updatedAt', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(1_000)
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		expect(created.state).toEqual({
			schemaVersion: 1,
			pinned: false,
			createdAt: 1_000,
			updatedAt: 1_000,
		})

		vi.setSystemTime(2_000)
		await store.setPinned(created.id, true)
		expect((await store.read(created.id)).state).toEqual({
			schemaVersion: 1,
			pinned: true,
			createdAt: 1_000,
			updatedAt: 2_000,
		})
		expect(
			JSON.parse(disk.get(`${directory(created.id)}/${APP_STATE_FILE}`)!),
		).toEqual(expect.objectContaining({ pinned: true, updatedAt: 2_000 }))

		vi.setSystemTime(3_000)
		await new AppStore(app, lifecycle).setPinned(created.id, false)
		expect((await store.read(created.id)).state.pinned).toBe(false)
		expect((await store.read(created.id)).state.updatedAt).toBe(3_000)
	})

	it('reads empty App data by default and persists the versioned envelope', async () => {
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		expect(await store.readKV(created.id)).toEqual({})
		expect(disk.has(`${directory(created.id)}/${APP_DATA_FILE}`)).toBe(false)

		await store.transact(created.id, [
			{ key: '进度 Progress 🌿', value: 2 },
			{ key: '设置 Settings 中文', value: false },
		])
		expect(
			JSON.parse(disk.get(`${directory(created.id)}/${APP_DATA_FILE}`)!),
		).toEqual({
			schemaVersion: 1,
			kv: { '进度 Progress 🌿': 2, '设置 Settings 中文': false },
		})
		expect(await store.readKV(created.id)).toEqual({
			'进度 Progress 🌿': 2,
			'设置 Settings 中文': false,
		})

		await store.transact(created.id, [
			{ key: '进度 Progress 🌿', delete: true },
			{ key: '完成 Done 🌿', value: ['中文', 'English', '🌿'] },
		])
		expect(await store.readKV(created.id)).toEqual({
			'设置 Settings 中文': false,
			'完成 Done 🌿': ['中文', 'English', '🌿'],
		})
	})

	it('rejects lossy, unsafe and oversized data at the store boundary', async () => {
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		await store.transact(created.id, [{ key: '计数 Count', value: 1 }])
		const dataPath = `${directory(created.id)}/${APP_DATA_FILE}`
		const before = disk.get(dataPath)

		for (const changes of [
			[{ key: '数据 Data 🌿', value: undefined }],
			[{ key: '__proto__', value: 1 }],
			[
				{
					key: '数据 Data 🌿',
					value: '🌿'.repeat(Math.ceil(MAX_VALUE_BYTES / 4) + 1),
				},
			],
			Array.from({ length: 101 }, (_, index) => ({
				key: `条目 ${index}`,
				value: index,
			})),
		])
			await expect(
				store.transact(created.id, changes as never),
			).rejects.toThrow()
		expect(disk.get(dataPath)).toBe(before)
		expect(await store.readKV(created.id)).toEqual({ '计数 Count': 1 })

		disk.set(dataPath, JSON.stringify({ schemaVersion: 2, kv: {} }))
		await expect(store.readKV(created.id)).rejects.toThrow(/Invalid App data/)
		disk.set(dataPath, '[]')
		await expect(store.readKV(created.id)).rejects.toThrow(/Invalid App data/)
	})

	it('serializes concurrent transactions so no update is lost', async () => {
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		await Promise.all([
			store.transact(created.id, [{ key: '记录 Record 🌿', value: 1 }]),
			store.transact(created.id, [{ key: '第二 Second 🧭', value: 2 }]),
			store.transact(created.id, [
				{ key: '设置 Settings 中文', value: { '主题 Theme': '🌿' } },
			]),
		])
		expect(await store.readKV(created.id)).toEqual({
			'记录 Record 🌿': 1,
			'第二 Second 🧭': 2,
			'设置 Settings 中文': { '主题 Theme': '🌿' },
		})
		await store.settle()
	})

	it('removes the whole App directory and leaves other Apps untouched', async () => {
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		const other = await store.create(
			'org.example.journal',
			'中性日记 Neutral journal 🌿',
		)
		await store.transact(created.id, [{ key: '进度 Progress 🌿', value: 1 }])
		const events: Array<string | undefined> = []
		const unsubscribe = store.subscribe((appId) => events.push(appId))
		events.length = 0

		await store.remove(created.id)
		expect(
			[...disk.keys()].some((path) =>
				path.startsWith(`${directory(created.id)}/`),
			),
		).toBe(false)
		expect(await store.exists(created.id)).toBe(false)
		await expect(store.read(created.id)).rejects.toThrow()
		expect(
			[...disk.keys()].some((path) =>
				path.startsWith(`${directory(created.id)}/`),
			),
		).toBe(false)
		expect(await store.read(other.id)).toEqual(other)
		expect(events).toContain(created.id)
		expect(events).not.toContain(other.id)
		unsubscribe()
	})

	it('notifies source and state changes but never host data or log writes', async () => {
		const store = new AppStore(app, lifecycle)
		const created = await store.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		const other = await store.create(
			'org.example.journal',
			'中性日记 Neutral journal 🌿',
		)
		const events: Array<string | undefined> = []
		const unsubscribe = store.subscribe((appId) => events.push(appId))
		events.length = 0
		const path = (id: string, name: string) => `${directory(id)}/${name}`

		await writeLocalTextAtomic(
			app.vault,
			path(created.id, 'index.html'),
			'<p>中性内容 Neutral content 🌿</p>',
		)
		expect(events).toEqual([created.id])

		events.length = 0
		await store.transact(created.id, [{ key: '计数 Count', value: 2 }])
		await writeLocalTextAtomic(
			app.vault,
			path(created.id, APP_DATA_FILE),
			JSON.stringify({ schemaVersion: 1, kv: {} }),
		)
		await writeLocalTextAtomic(app.vault, path(created.id, APP_LOG_FILE), '')
		expect(events).toEqual([])

		await store.setPinned(created.id, true)
		expect(events).toEqual([created.id])

		events.length = 0
		await writeLocalTextAtomic(
			app.vault,
			path(other.id, 'styles.css'),
			'h1{color:green}',
		)
		expect(events).toEqual([other.id])

		events.length = 0
		await writeLocalTextAtomic(
			app.vault,
			'unrelated/notes.md',
			'中性笔记 Neutral note 🌿',
		)
		await writeLocalTextAtomic(app.vault, `${APP_ROOT_DIR}/README.md`, '')
		expect(events).toEqual([])
		unsubscribe()
		expect(pathListeners.size).toBe(0)
	})
})

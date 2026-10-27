// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import { ModuleScope } from '~/modules/lifecycle'
import {
	APP_DATA_FILE,
	APP_ENTRY_FILE,
	APP_LOG_FILE,
	APP_MANIFEST_FILE,
	APP_STATE_FILE,
	appDirectoryPath,
} from './paths'
import { type AppContent } from './source'
import { type KVChange } from './capabilities/kv'
import { AppWorkspaces } from './workspaces'
import { VaultFileSystemManager } from '~/ai/tools/vault-filesystem'
import type { RuntimeHost } from './runtime'
import { readLocalText } from '~/utils/local-vault-io'

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

const disk = vi.hoisted(() => new Map<string, string>())
const binary = vi.hoisted(() => new Map<string, ArrayBuffer>())
const pathListeners = vi.hoisted(() => new Set<(path: string) => void>())
const logWrite = vi.hoisted(() => ({
	gate: undefined as Promise<void> | undefined,
	started: undefined as (() => void) | undefined,
}))
const logger = vi.hoisted(() => ({ error: vi.fn() }))
const permissionGuard = vi.hoisted(() => vi.fn(async () => {}))
const runtimeControl = vi.hoisted(() => ({
	fail: false,
	gate: undefined as Promise<void> | undefined,
	starts: 0,
	active: 0,
	instances: [] as Array<{
		container: HTMLElement
		content: AppContent
		host: RuntimeHost
		initialKV: Record<string, unknown>
		destroyed: boolean
	}>,
}))

vi.mock('~/utils/logger', () => ({ default: logger }))
vi.mock('~/utils/mkdirs-vault', () => ({ mkdirsVault: async () => {} }))
vi.mock('~/ai/tools/permission-guard', () => ({
	createPermissionGuard: () => permissionGuard,
}))
vi.mock('~/ai/skills/builtin', () => ({
	createBuiltinSkillsFs: async () => ({}),
}))
vi.mock('~/utils/local-vault-io', () => ({
	existsLocalPath: async (_vault: unknown, path: string) =>
		disk.has(path) ||
		binary.has(path) ||
		[...disk.keys()].some((key) => key.startsWith(`${path}/`)) ||
		[...binary.keys()].some((key) => key.startsWith(`${path}/`)),
	readLocalText: vi.fn(async (_vault: unknown, path: string) => {
		if (!disk.has(path)) throw new Error(`Missing file: ${path}`)
		return disk.get(path)!
	}),
	readLocalBinary: async (_vault: unknown, path: string) => {
		if (!binary.has(path)) throw new Error(`Missing file: ${path}`)
		return binary.get(path)!
	},
	writeLocalTextAtomic: async (
		_vault: unknown,
		path: string,
		content: string,
	) => {
		disk.set(path, content)
		for (const listener of pathListeners) listener(path)
	},
	removeLocalPath: async (_app: unknown, path: string) => {
		for (const key of [...disk.keys()])
			if (key === path || key.startsWith(`${path}/`)) disk.delete(key)
		for (const key of [...binary.keys()])
			if (key === path || key.startsWith(`${path}/`)) binary.delete(key)
		for (const listener of pathListeners) listener(path)
	},
	onLocalPathChanged: (listener: (path: string) => void) => {
		pathListeners.add(listener)
		return () => pathListeners.delete(listener)
	},
}))
vi.mock('./runtime', () => ({
	AppRuntime: class {
		readonly ready: Promise<void>
		private destroyed = false
		constructor(
			container: HTMLElement,
			content: AppContent,
			host: RuntimeHost,
		) {
			runtimeControl.starts++
			runtimeControl.active++
			const instance = {
				container,
				content,
				host,
				initialKV: {} as Record<string, unknown>,
				destroyed: false,
			}
			runtimeControl.instances.push(instance)
			this.ready = (async () => {
				instance.initialKV = await host.readKV()
				host.log({
					level: 'info',
					source: 'console',
					message: '启动记录 Startup entry 🌿',
				})
				await host.transact([
					{ key: '临时 Temporary 🌿', value: '试运行 Candidate 中文' },
				])
				await runtimeControl.gate
				if (runtimeControl.fail) {
					host.log({
						level: 'error',
						source: 'startup',
						message: '启动失败 Startup failed 🌿',
					})
					throw new Error('启动失败 Startup failed 🌿')
				}
			})()
		}
		destroy() {
			if (!this.destroyed) {
				this.destroyed = true
				runtimeControl.active--
				const instance = runtimeControl.instances.at(-1)
				if (instance) instance.destroyed = true
			}
		}
	},
}))

function normalize(path: string) {
	return path.replace(/^\/+/, '').replace(/\/+$/, '')
}
const adapter = {
	exists: async (path: string) => {
		const target = normalize(path)
		return (
			disk.has(target) ||
			binary.has(target) ||
			[...disk.keys()].some((key) => key.startsWith(`${target}/`))
		)
	},
	read: async (path: string) => {
		const target = normalize(path)
		if (!disk.has(target)) throw new Error(`Missing file: ${target}`)
		return disk.get(target)!
	},
	write: async (path: string, content: string) => {
		disk.set(normalize(path), content)
	},
	process: async (path: string, update: (content: string) => string) => {
		const target = normalize(path)
		if (target.endsWith(`/${APP_LOG_FILE}`)) {
			logWrite.started?.()
			await logWrite.gate
		}
		const next = update(disk.get(target) ?? '')
		disk.set(target, next)
		return next
	},
	list: async (path: string) => {
		const target = normalize(path)
		const prefix = target ? `${target}/` : ''
		const folders = new Set<string>()
		for (const key of disk.keys()) {
			if (!key.startsWith(prefix)) continue
			const rest = key.slice(prefix.length)
			const separator = rest.indexOf('/')
			if (separator >= 0) folders.add(`${prefix}${rest.slice(0, separator)}`)
		}
		return { files: [], folders: [...folders] }
	},
	remove: async (path: string) => {
		disk.delete(normalize(path))
	},
	rmdir: async (path: string) => {
		const target = normalize(path)
		for (const key of [...disk.keys()])
			if (key === target || key.startsWith(`${target}/`)) disk.delete(key)
	},
}

function fixture() {
	Object.defineProperty(document, 'win', {
		configurable: true,
		// eslint-disable-next-line obsidianmd/prefer-create-el -- Supply Obsidian's document helper in jsdom.
		value: { createDiv: () => document.createElement('div') },
	})
	const app = {
		vault: {
			configDir: '.obsidian',
			adapter,
			getAllLoadedFiles: () => [],
		},
		fileManager: {},
		workspace: { containerEl: document.body },
	} as unknown as App
	const scope = new ModuleScope()
	const service = new AppWorkspaces(app, scope)
	const session = {
		schemaVersion: 2,
		id: 'neutral-chat',
		createdAt: 1,
		updatedAt: 1,
		subagents: {},
	} as ChatSession
	const persist = vi.fn(async () => {})
	return { app, scope, service, session, persist }
}
function sourcePath(id: string, name: string) {
	return `${appDirectoryPath(id)}/${name}`
}
function bytes(value: string) {
	return new TextEncoder().encode(value).buffer as ArrayBuffer
}
function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((complete) => {
		resolve = complete
	})
	return { promise, resolve }
}
function text(path: string) {
	return disk.get(path) ?? ''
}

beforeEach(() => {
	disk.clear()
	binary.clear()
	pathListeners.clear()
	logWrite.gate = undefined
	logWrite.started = undefined
	logger.error.mockClear()
	permissionGuard.mockClear()
	runtimeControl.fail = false
	runtimeControl.gate = undefined
	runtimeControl.starts = 0
	runtimeControl.active = 0
	runtimeControl.instances.length = 0
	document.body.replaceChildren()
})

afterEach(() => {
	delete (document as { win?: unknown }).win
})

describe('App workspaces over real App files', () => {
	it('creates App files and loads the assembled source tree', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		expect(created.manifest.title).toBe('中性清单 Neutral checklist 🌿')
		expect(disk.has(sourcePath(created.id, APP_MANIFEST_FILE))).toBe(true)
		expect(disk.has(sourcePath(created.id, APP_STATE_FILE))).toBe(true)

		disk.set(
			sourcePath(created.id, APP_ENTRY_FILE),
			[
				'<link rel="stylesheet" href="styles/main.css">',
				'<main class="card">进度 Progress 中文 🌿</main>',
				'<script src="app.js"></script>',
			].join(''),
		)
		disk.set(
			sourcePath(created.id, 'styles/main.css'),
			'.card { color: green; background: url(../assets/dot.png); }',
		)
		disk.set(sourcePath(created.id, 'app.js'), 'const note = "脚本 Script 🌿"')
		binary.set(sourcePath(created.id, 'assets/dot.png'), bytes('中性资源 🌿'))

		const loaded = await service.load(created.id)
		expect(loaded).toMatchObject({ id: created.id, manifest: created.manifest })
		expect(loaded.content.html).toContain('进度 Progress 中文 🌿')
		expect(loaded.content.html).not.toContain('link')
		expect(loaded.content.css).toContain('.card { color: green;')
		expect(loaded.content.css).toContain('data:image/png;base64,')
		expect(loaded.content.javascript).toBe('const note = "脚本 Script 🌿"')
	})

	it('loads empty content when the App has no index.html yet', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.journal',
			'中性日记 Neutral journal 🌿',
		)
		expect(await service.load(created.id)).toMatchObject({
			id: created.id,
			content: { html: '', css: '', javascript: '' },
		})
	})

	it('propagates source assembly errors to load and validate', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.reader',
			'中性阅读器 Neutral reader 🌿',
		)
		disk.set(
			sourcePath(created.id, APP_ENTRY_FILE),
			'<link rel="stylesheet" href="https://example.test/styles.css">',
		)

		await expect(service.load(created.id)).rejects.toThrow(
			/Remote URL is not supported/,
		)
		await expect(service.validate(created.id)).rejects.toThrow(
			/Remote URL is not supported/,
		)
		expect(runtimeControl.starts).toBe(0)
	})

	it('rejects a manifest icon that is not inert SVG geometry', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.gallery',
			'中性画廊 Neutral gallery 🌿',
		)
		expect(service.validateIcon(created.manifest.iconSvg)).toContain('svg')
		expect(() => service.validateIcon('<svg><script>1</script></svg>')).toThrow(
			/viewBox/,
		)

		const manifestPath = sourcePath(created.id, APP_MANIFEST_FILE)
		disk.set(
			manifestPath,
			JSON.stringify({
				...created.manifest,
				iconSvg: '<svg viewBox="0 0 100 100"><script>1</script></svg>',
			}),
		)
		await expect(service.load(created.id)).rejects.toThrow()
		await expect(service.validate(created.id)).rejects.toThrow()
		expect(runtimeControl.starts).toBe(0)
	})

	it('validates in a throwaway sandbox with a cloned KV and disposes it', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.counter',
			'中性计数器 Neutral counter 🌿',
		)
		await service.store.transact(created.id, [
			{ key: '次数 Count 🌿', value: 1 },
		])
		disk.set(
			sourcePath(created.id, APP_ENTRY_FILE),
			'<p>中性计数器 Neutral counter 🌿</p>',
		)

		const validated = await service.validate(created.id)
		expect(validated.content.html).toContain('中性计数器 Neutral counter 🌿')
		expect(runtimeControl.starts).toBe(1)
		const [candidate] = runtimeControl.instances
		expect(candidate.initialKV).toEqual({ '次数 Count 🌿': 1 })
		expect(candidate.destroyed).toBe(true)
		expect(runtimeControl.active).toBe(0)
		expect(document.querySelector('.ns-app-candidate')).toBeNull()
		expect(document.body.contains(candidate.container)).toBe(false)

		// Candidate transactions landed only in the disposable clone.
		expect(await service.store.readKV(created.id)).toEqual({
			'次数 Count 🌿': 1,
		})
		expect(JSON.parse(text(sourcePath(created.id, APP_DATA_FILE))).kv).toEqual({
			'次数 Count 🌿': 1,
		})
		expect(text(sourcePath(created.id, APP_LOG_FILE))).toContain(
			'启动记录 Startup entry 🌿',
		)
	})

	it('rejects failed candidate startup with the log path and without writing KV', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.calendar',
			'中性日历 Neutral calendar 🌿',
		)
		await service.store.transact(created.id, [
			{ key: '进度 Progress 🌿', value: 3 },
		])
		disk.set(
			sourcePath(created.id, APP_ENTRY_FILE),
			'<p>中性日历 Neutral calendar 🌿</p>',
		)
		runtimeControl.fail = true

		await expect(service.validate(created.id)).rejects.toThrow(
			/启动失败 Startup failed 🌿[\s\S]*Runtime logs: \.agents\/nutstore-sync\/apps\/org\.example\.calendar\/logs\.jsonl/,
		)
		expect(runtimeControl.active).toBe(0)
		expect(document.querySelector('.ns-app-candidate')).toBeNull()
		expect(await service.store.readKV(created.id)).toEqual({
			'进度 Progress 🌿': 3,
		})
		expect(text(sourcePath(created.id, APP_DATA_FILE))).not.toContain(
			'临时 Temporary',
		)
		await vi.waitFor(() =>
			expect(text(sourcePath(created.id, APP_LOG_FILE))).toContain(
				'启动失败 Startup failed 🌿',
			),
		)
	})

	it('cancels validation when the signal aborts during candidate boot', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.viewer',
			'中性查看器 Neutral viewer 🌿',
		)
		disk.set(
			sourcePath(created.id, APP_ENTRY_FILE),
			'<p>候选项 Candidate 🌿</p>',
		)
		runtimeControl.gate = new Promise(() => {})
		const controller = new AbortController()
		const pending = service.validate(created.id, controller.signal)
		await vi.waitFor(() => expect(runtimeControl.starts).toBe(1))
		controller.abort()
		await expect(pending).rejects.toThrow()
		expect(runtimeControl.active).toBe(0)
		expect(document.querySelector('.ns-app-candidate')).toBeNull()

		const aborted = new AbortController()
		aborted.abort()
		await expect(service.validate(created.id, aborted.signal)).rejects.toThrow()
	})

	it('rejects I/O after the module scope closes', async () => {
		const { service, scope } = fixture()
		const created = await service.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		scope.close()
		await expect(service.load(created.id)).rejects.toThrow()
		await expect(service.setPinned(created.id, true)).rejects.toThrow()
		await expect(service.remove(created.id)).rejects.toThrow()
		await expect(
			service.create('org.example.next', '中性应用 🌿'),
		).rejects.toThrow()
	})

	it('creates a runtime host that delegates data, logs and errors', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.tools',
			'中性工具 Neutral tool 🌿',
		)
		await service.store.transact(created.id, [
			{ key: '设置 Settings 🌿', value: { '语言 Language': '中文 🌿' } },
		])
		const host = service.createRuntimeHost(created.id)
		expect(await host.readKV()).toEqual({
			'设置 Settings 🌿': { '语言 Language': '中文 🌿' },
		})

		const changes: KVChange[] = [
			{ key: '记录 Record 🌿', value: ['中文', 'English', '🌿'] },
			{ key: '设置 Settings 🌿', delete: true },
		]
		await host.transact(changes)
		expect(await service.store.readKV(created.id)).toEqual({
			'记录 Record 🌿': ['中文', 'English', '🌿'],
		})

		host.log({
			level: 'warn',
			source: 'console',
			message: '中性日志 Neutral log 🌿',
		})
		await service.logs.flush(created.id)
		const stored = text(sourcePath(created.id, APP_LOG_FILE))
		expect(stored).toContain('中性日志 Neutral log 🌿')
		expect(JSON.parse(stored.trim())).toMatchObject({
			schemaVersion: 1,
			appId: created.id,
			level: 'warn',
			source: 'console',
		})
		expect(Object.keys(JSON.parse(stored.trim()))).not.toContain('revisionId')

		host.error('中性错误 Neutral failure 🌿')
		expect(logger.error).toHaveBeenCalledWith('中性错误 Neutral failure 🌿')
	})

	it('uninstalls other Apps and itself with confirmation while protecting App files', async () => {
		const { service } = fixture()
		const current = await service.create(
			'org.example.files',
			'中性文件管理器 Neutral file manager 🌿',
		)
		const target = await service.create(
			'org.example.archive',
			'中性归档 Neutral archive 🌿',
		)
		disk.set(
			sourcePath(target.id, APP_ENTRY_FILE),
			'<p>中性内容 Neutral content 🌿</p>',
		)
		const host = service.createRuntimeHost(current.id)

		await expect(
			host.fs!('rm', [`${appDirectoryPath(target.id)}/${APP_ENTRY_FILE}`]),
		).rejects.toThrow(/EROFS/)
		await expect(
			host.fs!('rm', [`${appDirectoryPath(target.id)}/${APP_DATA_FILE}`]),
		).rejects.toThrow(/EROFS/)
		await host.fs!('rm', [appDirectoryPath(target.id), { recursive: true }])

		expect(permissionGuard).toHaveBeenCalledWith(
			expect.objectContaining({
				fs: { kind: 'delete', path: `/${appDirectoryPath(target.id)}` },
			}),
		)
		expect(disk.has(sourcePath(target.id, APP_MANIFEST_FILE))).toBe(false)
		expect(disk.has(sourcePath(current.id, APP_MANIFEST_FILE))).toBe(true)
		host.log({
			level: 'info',
			source: 'console',
			message: '结束记录 Final entry 🌿',
		})
		await host.fs!('rm', [appDirectoryPath(current.id), { recursive: true }])
		await expect(
			host.transact([{ key: '记录 Record 🌿', value: 1 }]),
		).rejects.toThrow(/no longer exists/)
		await service.logs.flush(current.id)
		expect(disk.has(sourcePath(current.id, APP_LOG_FILE))).toBe(false)
		expect(disk.has(sourcePath(current.id, APP_MANIFEST_FILE))).toBe(false)
		expect(permissionGuard).toHaveBeenCalledWith(
			expect.objectContaining({
				fs: { kind: 'delete', path: `/${appDirectoryPath(current.id)}` },
			}),
		)
	})

	it('uses the same confirmed uninstall for Agent file operations and protects ancestor directories', async () => {
		const { app, service } = fixture()
		const created = await service.create(
			'org.example.archive',
			'中性归档 Neutral archive 🌿',
		)
		const fs = await new VaultFileSystemManager(app).create({
			appLifecycle: service,
			permissionGuard,
		})
		for (const path of [
			'/.agents',
			'/.agents/nutstore-sync',
			'/.agents/nutstore-sync/apps',
		]) {
			await expect(fs.rm(path, { recursive: true })).rejects.toThrow(/EBUSY/)
			await expect(fs.mv(path, '/Archive 归档 🌿')).rejects.toThrow(/EBUSY/)
		}
		await expect(
			fs.mv(
				`/${appDirectoryPath(created.id)}`,
				`/${appDirectoryPath('org.example.other')}`,
			),
		).rejects.toThrow(/EROFS/)
		expect(permissionGuard).not.toHaveBeenCalled()
		permissionGuard.mockImplementationOnce(async () => {
			throw new Error('取消 Cancelled 🌿')
		})
		await expect(
			fs.rm(`/${appDirectoryPath(created.id)}`, { recursive: true }),
		).rejects.toThrow('取消 Cancelled 🌿')
		expect(await service.store.exists(created.id)).toBe(true)
		await fs.rm(`/${appDirectoryPath(created.id)}`, { recursive: true })
		expect(await service.store.exists(created.id)).toBe(false)
		await fs.rm(`/${appDirectoryPath(created.id)}`, {
			recursive: true,
			force: true,
		})
	})

	it('rejects Vault path aliases before mount routing or permission checks', async () => {
		const { app, service } = fixture()
		const created = await service.create(
			'org.example.reader',
			'中性阅读器 Neutral reader 🌿',
		)
		const fs = await new VaultFileSystemManager(app).create({
			appLifecycle: service,
			permissionGuard,
		})
		const appRoot = appDirectoryPath(created.id)
		const appAlias = `/${appRoot.split('/').join('\\')}`

		await expect(
			fs.rm('/.agents\\nutstore-sync', { recursive: true }),
		).rejects.toThrow(/EINVAL/)
		await expect(
			fs.writeFile(`${appAlias}\\data.json`, '{"记录 Record 🌿":1}'),
		).rejects.toThrow(/EINVAL/)
		await expect(fs.rm(`${appAlias}\\data.json`)).rejects.toThrow(/EINVAL/)

		expect(await service.store.exists(created.id)).toBe(true)
		expect(permissionGuard).not.toHaveBeenCalled()
	})

	it('queues uninstall behind an in-flight KV transaction', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.counter',
			'中性计数器 Neutral counter 🌿',
		)
		await service.store.transact(created.id, [
			{ key: '初始 Initial 🌱', value: 1 },
		])
		const host = service.createRuntimeHost(created.id)
		const readStarted = deferred()
		const releaseRead = deferred()
		const removeApp = vi.spyOn(service.store, 'remove')
		vi.mocked(readLocalText).mockImplementationOnce(async (_vault, path) => {
			if (path === sourcePath(created.id, APP_DATA_FILE)) {
				readStarted.resolve()
				await releaseRead.promise
			}
			if (!disk.has(path)) throw new Error(`Missing file: ${path}`)
			return disk.get(path)!
		})

		const transaction = host.transact([{ key: '更新 Update 🧭', value: 2 }])
		await readStarted.promise
		const removal = host.fs!('rm', [
			appDirectoryPath(created.id),
			{ recursive: true },
		])
		try {
			await vi.waitFor(() =>
				expect(removeApp).toHaveBeenCalledWith(created.id, {
					force: undefined,
				}),
			)
		} finally {
			releaseRead.resolve()
		}
		await Promise.all([transaction, removal])

		expect(await service.store.exists(created.id)).toBe(false)
		expect(
			[...disk.keys()].some((path) =>
				path.startsWith(`${appDirectoryPath(created.id)}/`),
			),
		).toBe(false)
	})

	it('queues uninstall behind an in-flight log flush', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.diagnostics',
			'中性诊断 Neutral diagnostics 🌿',
		)
		const writeStarted = deferred()
		const releaseWrite = deferred()
		logWrite.gate = releaseWrite.promise
		logWrite.started = writeStarted.resolve
		service.logs.append(created.id, {
			level: 'info',
			source: 'runtime',
			message: '日志写入 Log write 🌿',
		})

		const flushing = service.logs.flush(created.id)
		await writeStarted.promise
		const removal = service.remove(created.id)
		releaseWrite.resolve()
		await Promise.all([flushing, removal])

		expect(
			[...disk.keys()].some((path) =>
				path.startsWith(`${appDirectoryPath(created.id)}/`),
			),
		).toBe(false)
	})

	it('binds App access only when the selection actually changes and rolls back failures', async () => {
		const { service, session, persist } = fixture()
		const first = await service.create(
			'org.example.journal',
			'中性日记 Neutral journal 🌿',
		)
		const second = await service.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		const binding = service.createBinding(session, persist)

		await binding.access(first.id)
		expect(session.appId).toBe(first.id)
		expect(binding.selectedAppId()).toBe(first.id)
		expect(persist).toHaveBeenCalledOnce()

		await binding.access(first.id)
		expect(persist).toHaveBeenCalledOnce()

		await binding.access(second.id, true)
		expect(session.appId).toBe(first.id)
		expect(persist).toHaveBeenCalledOnce()

		await binding.access(second.id)
		expect(session.appId).toBe(second.id)
		expect(persist).toHaveBeenCalledTimes(2)

		await expect(binding.access('org.example.missing')).rejects.toThrow()
		expect(session.appId).toBe(second.id)
		expect(persist).toHaveBeenCalledTimes(2)

		persist.mockRejectedValueOnce(new Error('保存失败 Save failed 🌿'))
		await expect(binding.access(first.id)).rejects.toThrow('Save failed')
		expect(binding.selectedAppId()).toBe(second.id)
		await binding.access(first.id)
		expect(binding.selectedAppId()).toBe(first.id)
	})

	it('stops binding when the module scope closes', async () => {
		const { service, scope, session, persist } = fixture()
		await service.create('org.example.journal', '中性日记 Neutral journal 🌿')
		const binding = service.createBinding(session, persist)
		scope.close()
		await expect(binding.access('org.example.journal')).rejects.toThrow()
		expect(persist).not.toHaveBeenCalled()
		expect(binding.check).toThrow()
	})

	it('delegates pinning and App removal to the store', async () => {
		const { service } = fixture()
		const created = await service.create(
			'org.example.checklist',
			'中性清单 Neutral checklist 🌿',
		)
		await service.setPinned(created.id, true)
		expect((await service.store.read(created.id)).state.pinned).toBe(true)

		await service.remove(created.id)
		expect(disk.has(sourcePath(created.id, APP_MANIFEST_FILE))).toBe(false)
		await expect(service.store.read(created.id)).rejects.toThrow()
	})
})

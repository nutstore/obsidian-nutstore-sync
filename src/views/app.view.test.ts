// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceLeaf } from 'obsidian'
import type NutstorePlugin from '~/index'
import type { AppContent } from '~/ai/apps/source'
import type { LoadedApp } from '~/ai/apps/workspaces'
import type { RuntimeHost } from '~/ai/apps/runtime'
import AppView from './app.view'
import i18n from '~/i18n'

const diagnostics = vi.hoisted(() => ({
	notice: vi.fn(),
	error: vi.fn(),
	icon: vi.fn(),
}))
vi.mock('~/utils/logger', () => ({ default: { error: diagnostics.error } }))

/* eslint-disable obsidianmd/prefer-create-el -- Host DOM extensions are supplied by this jsdom fixture. */
function element(
	tag = 'div',
	options: { cls?: string; text?: string; attr?: Record<string, string> } = {},
) {
	const el = document.createElement(tag)
	if (options.cls) el.className = options.cls
	if (options.text) el.textContent = options.text
	for (const [key, value] of Object.entries(options.attr ?? {}))
		el.setAttribute(key, value)
	return Object.assign(el, {
		createEl: (name: string, opts?: typeof options) =>
			el.appendChild(element(name, opts)),
		createDiv: (opts?: typeof options) => el.appendChild(element('div', opts)),
		createSpan: (opts?: typeof options) =>
			el.appendChild(element('span', opts)),
		empty: () => el.replaceChildren(),
		addClass: (name: string) => el.classList.add(name),
	})
}
/* eslint-enable obsidianmd/prefer-create-el -- Re-enable Obsidian DOM helper check after fixture setup. */
vi.mock('obsidian', () => ({
	ItemView: class {
		contentEl = element()
		constructor(readonly leaf: WorkspaceLeaf) {}
		async setState() {}
		registerDomEvent(el: HTMLElement, name: string, handler: EventListener) {
			el.addEventListener(name, handler)
		}
	},
	Notice: class {
		constructor(message: string) {
			diagnostics.notice(message)
		}
	},
	setIcon: diagnostics.icon,
}))
const runtimes = vi.hoisted(
	() =>
		[] as Array<{
			content: AppContent
			host: RuntimeHost
			title?: string
			destroyed: boolean
			themeUpdates: number
		}>,
)
vi.mock('~/ai/apps/runtime', () => ({
	AppRuntime: class {
		ready = Promise.resolve()
		destroyed = false
		themeUpdates = 0
		constructor(
			_output: HTMLElement,
			content: AppContent,
			host: RuntimeHost,
			title?: string,
		) {
			runtimes.push({
				content,
				host,
				title,
				destroyed: false,
				themeUpdates: 0,
			})
		}
		destroy() {
			this.destroyed = true
			const record = runtimes.at(-1)
			if (record) record.destroyed = true
		}
		updateTheme() {
			this.themeUpdates++
			const record = runtimes.at(-1)
			if (record) record.themeUpdates++
		}
	},
}))

function loadedApp(
	overrides: {
		title?: string
		pinned?: boolean
		html?: string
		javascript?: string
		iconSvg?: string
	} = {},
): LoadedApp {
	return {
		id: 'neutral-app',
		manifest: {
			schemaVersion: 1,
			title: overrides.title ?? '清单 Checklist 中文 🌿',
			iconSvg:
				overrides.iconSvg ??
				'<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="currentColor"/></svg>',
			dataVersion: 1,
		},
		state: {
			schemaVersion: 1,
			pinned: overrides.pinned ?? false,
			createdAt: 1_000,
			updatedAt: 2_000,
		},
		content: {
			html: overrides.html ?? '<p>清单 Checklist 中文 🌿</p>',
			css: '.item { color: green; }',
			javascript: overrides.javascript ?? '',
		},
	}
}

function fixture() {
	let loaded = loadedApp()
	const storeListeners = new Set<(appId?: string) => void>()
	const themeListeners = new Set<() => void>()
	const workspaces = {
		load: vi.fn(async () => structuredClone(loaded)),
		validate: vi.fn(async () => structuredClone(loaded)),
		createRuntimeHost: vi.fn((): RuntimeHost => ({
			readKV: async () => ({ '记录 Record 🌿': 1 }),
			transact: async () => {},
			log: () => {},
			error: () => {},
		})),
	}
	const apps = {
		read: vi.fn(async () => structuredClone(loaded)),
		setPinned: vi.fn(async () => {}),
		subscribe: (listener: (appId?: string) => void) => {
			storeListeners.add(listener)
			return () => storeListeners.delete(listener)
		},
	}
	const editApp = vi.fn(async () => {})
	const appIcon = vi.fn((id: string) => `icon-${id}`)
	const plugin = {
		app: {
			workspace: {
				on: (name: string, callback: () => void) => {
					expect(name).toBe('css-change')
					themeListeners.add(callback)
					return { callback }
				},
				offref: (ref: { callback: () => void }) => {
					themeListeners.delete(ref.callback)
				},
			},
		},
		ai: {
			lifecycle: { active: true },
			appIcon,
			editApp,
			apps,
			workspaces,
		},
	} as unknown as NutstorePlugin
	const leaf = { detach: vi.fn() }
	const view = new AppView(leaf as unknown as WorkspaceLeaf, plugin)
	return {
		view,
		leaf,
		plugin,
		workspaces,
		apps,
		editApp,
		appIcon,
		storeListeners,
		themeListeners,
		get loaded() {
			return loaded
		},
		setLoaded(next: LoadedApp) {
			loaded = next
		},
		notifyStore: (appId?: string) => {
			for (const listener of storeListeners) listener(appId)
		},
		notifyTheme: () => {
			for (const listener of themeListeners) listener()
		},
		async open() {
			await view.setState({ appId: loaded.id }, { history: false })
			await view.onOpen()
		},
	}
}
async function settle(times = 2) {
	for (let index = 0; index < times; index++) await Promise.resolve()
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

afterEach(() => {
	vi.useRealTimers()
	runtimes.length = 0
	vi.clearAllMocks()
	document.body.replaceChildren()
})

describe('App view sandbox lifetime', () => {
	it('loads, validates and mounts the App runtime with the manifest title', async () => {
		const f = fixture()
		await f.open()

		expect(f.workspaces.load).toHaveBeenCalledWith('neutral-app')
		expect(f.workspaces.validate).toHaveBeenCalledWith('neutral-app')
		expect(runtimes).toHaveLength(1)
		expect(runtimes[0].content).toEqual(f.loaded.content)
		expect(runtimes[0].title).toBe('清单 Checklist 中文 🌿')
		expect(f.workspaces.createRuntimeHost).toHaveBeenCalledWith(
			'neutral-app',
			expect.any(Function),
		)
		expect(f.view.contentEl.textContent).toContain('清单 Checklist 中文 🌿')
		expect(
			f.view.contentEl.querySelector(
				`button[aria-label="${i18n.t('apps.modify')}"]`,
			),
		).not.toBeNull()
		expect(
			f.view.contentEl.querySelector(
				`button[aria-label="${i18n.t('apps.pin')}"]`,
			),
		).not.toBeNull()
		// Only the current model's actions are exposed; no revision affordances remain.
		expect(
			f.view.contentEl.querySelectorAll('.ns-app-actions button'),
		).toHaveLength(2)
	})

	it('renders the authoring placeholder instead of booting an empty App', async () => {
		const f = fixture()
		f.setLoaded({
			...f.loaded,
			content: { html: '   ', css: '', javascript: '' },
		})
		await f.open()

		expect(f.workspaces.validate).not.toHaveBeenCalled()
		expect(runtimes).toHaveLength(0)
		expect(f.view.contentEl.textContent).toContain('清单 Checklist 中文 🌿')
		expect(f.view.contentEl.textContent).toContain(i18n.t('apps.describeApp'))
	})

	it('coalesces a burst of file notifications into one debounced reload', async () => {
		const f = fixture()
		await f.open()
		expect(runtimes).toHaveLength(1)
		f.workspaces.load.mockClear()
		f.workspaces.validate.mockClear()

		const updated = loadedApp({ html: '<p>完成 Done 中文 🌿</p>' })
		f.setLoaded(updated)
		vi.useFakeTimers()
		f.notifyStore('neutral-app')
		f.notifyStore('neutral-app')
		f.notifyStore('neutral-app')
		expect(f.workspaces.load).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(120)
		await settle()

		expect(f.workspaces.load).toHaveBeenCalledOnce()
		expect(f.workspaces.validate).toHaveBeenCalledOnce()
		expect(runtimes).toHaveLength(2)
		expect(runtimes[0].destroyed).toBe(true)
		expect(runtimes[1].content.html).toContain('完成 Done 中文 🌿')

		// Unchanged source does not replace a live iframe.
		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)
		await settle()
		expect(f.workspaces.load).toHaveBeenCalledTimes(2)
		expect(runtimes).toHaveLength(2)
	})

	it('ignores other Apps but reloads for a global notification', async () => {
		const f = fixture()
		await f.open()
		f.workspaces.load.mockClear()
		vi.useFakeTimers()

		f.notifyStore('other-app')
		await vi.advanceTimersByTimeAsync(200)
		expect(f.workspaces.load).not.toHaveBeenCalled()

		f.notifyStore(undefined)
		await vi.advanceTimersByTimeAsync(120)
		await settle()
		expect(f.workspaces.load).toHaveBeenCalledOnce()
		expect(runtimes).toHaveLength(1)
	})

	it('shows a load failure, tears the runtime down and recovers on the next change', async () => {
		const f = fixture()
		await f.open()
		const failure = new Error('读取失败 Load failed 🌿')
		f.workspaces.load.mockRejectedValueOnce(failure)
		f.setLoaded(loadedApp({ html: '<p>恢复 Recovered 🌿</p>' }))
		vi.useFakeTimers()

		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)
		await settle()
		const status = f.view.contentEl.querySelector('.ns-app-status')!
		expect(status.textContent).toContain('读取失败 Load failed 🌿')
		expect(status.classList.contains('ns-app-error')).toBe(true)
		expect(runtimes[0].destroyed).toBe(true)
		expect(runtimes).toHaveLength(1)
		expect(
			f.view.contentEl.querySelector('.ns-app-output')?.childElementCount,
		).toBe(0)

		f.workspaces.load.mockResolvedValue(f.loaded)
		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)
		await settle()
		expect(status.classList.contains('ns-app-error')).toBe(false)
		expect(status.textContent).toBe('')
		expect(runtimes).toHaveLength(2)
		expect(runtimes[1].destroyed).toBe(false)
	})

	it('keeps the previous App visible when candidate validation fails', async () => {
		const f = fixture()
		await f.open()
		const failure = new Error('启动失败 Startup failed 🌿')
		f.workspaces.validate.mockRejectedValueOnce(failure)
		f.setLoaded(loadedApp({ html: '<p>候选 Candidate 🌿</p>' }))
		vi.useFakeTimers()

		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)
		await settle()

		expect(f.workspaces.validate).toHaveBeenCalledTimes(2)
		expect(runtimes).toHaveLength(1)
		expect(runtimes[0].destroyed).toBe(false)
		await expect(runtimes[0].host.readKV()).resolves.toEqual({
			'记录 Record 🌿': 1,
		})
		expect(
			f.view.contentEl.querySelector('.ns-app-status')?.textContent,
		).toContain('启动失败 Startup failed 🌿')

		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)
		await settle()
		expect(runtimes).toHaveLength(2)
		expect(runtimes[0].destroyed).toBe(true)
		expect(runtimes[1].content.html).toContain('候选 Candidate 🌿')
	})

	it('keeps the active runtime usable until validation finishes and mounts the validated files', async () => {
		const f = fixture()
		await f.open()
		const pending = deferred<LoadedApp>()
		f.workspaces.validate.mockReturnValueOnce(pending.promise)
		f.setLoaded(loadedApp({ html: '<p>编辑 Editing 中文 🌿</p>' }))
		vi.useFakeTimers()
		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)
		await settle()

		expect(runtimes).toHaveLength(1)
		expect(runtimes[0].destroyed).toBe(false)
		await expect(runtimes[0].host.readKV()).resolves.toEqual({
			'记录 Record 🌿': 1,
		})

		const validated = loadedApp({
			title: '完成 Complete 中文 🌿',
			html: '<p>已验证 Validated 中文 🌿</p>',
		})
		pending.resolve(validated)
		await settle(4)
		expect(runtimes).toHaveLength(2)
		expect(runtimes[0].destroyed).toBe(true)
		expect(runtimes[1].content).toEqual(validated.content)
		expect(runtimes[1].title).toBe(validated.manifest.title)
		await expect(runtimes[0].host.readKV()).rejects.toThrow(
			'This App version is no longer active',
		)
	})

	it('discards a pending candidate when the files return to the active content', async () => {
		const f = fixture()
		await f.open()
		const active = f.loaded
		const candidate = loadedApp({ html: '<p>候选 Candidate 中文 🌿</p>' })
		const pending = deferred<LoadedApp>()
		f.workspaces.validate.mockReturnValueOnce(pending.promise)
		f.setLoaded(candidate)
		vi.useFakeTimers()
		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)

		f.setLoaded(active)
		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)
		pending.resolve(candidate)
		await settle(4)

		expect(runtimes).toHaveLength(1)
		expect(runtimes[0].destroyed).toBe(false)
		expect(runtimes[0].content).toEqual(active.content)
	})

	it('drops a late load result after the view closes', async () => {
		const f = fixture()
		await f.open()
		const pending = deferred<LoadedApp>()
		f.workspaces.load.mockReturnValueOnce(pending.promise)
		vi.useFakeTimers()
		f.notifyStore('neutral-app')
		await vi.advanceTimersByTimeAsync(120)
		expect(f.workspaces.load).toHaveBeenCalledTimes(2)

		await f.view.onClose()
		pending.resolve(loadedApp({ html: '<p>迟到 Late 🌿</p>' }))
		await settle(4)
		expect(runtimes).toHaveLength(1)
		expect(f.view.contentEl.childElementCount).toBe(0)
		expect(f.storeListeners.size).toBe(0)
		expect(f.themeListeners.size).toBe(0)
	})

	it('toggles the pin through the store and surfaces action failures', async () => {
		const f = fixture()
		await f.open()
		await f.view.contentEl
			.querySelector<HTMLButtonElement>(
				`button[aria-label="${i18n.t('apps.pin')}"]`,
			)!
			.click()
		await vi.waitFor(() =>
			expect(f.apps.setPinned).toHaveBeenCalledWith('neutral-app', true),
		)

		f.setLoaded(loadedApp({ pinned: true }))
		await f.view.contentEl
			.querySelector<HTMLButtonElement>(
				`button[aria-label="${i18n.t('apps.modify')}"]`,
			)!
			.click()
		await vi.waitFor(() =>
			expect(f.editApp).toHaveBeenCalledWith('neutral-app'),
		)

		const failure = new Error('保存失败 Save failed 🌿')
		f.apps.setPinned.mockRejectedValueOnce(failure)
		await f.view.contentEl
			.querySelector<HTMLButtonElement>(
				`button[aria-label="${i18n.t('apps.pin')}"]`,
			)!
			.click()
		await vi.waitFor(() =>
			expect(diagnostics.error).toHaveBeenCalledWith(
				'App action failed',
				'neutral-app',
				failure,
			),
		)
		expect(diagnostics.notice).toHaveBeenCalledWith(
			expect.stringContaining(failure.message),
		)
	})

	it('updates the open runtime on CSS changes and releases listeners on close', async () => {
		const f = fixture()
		await f.open()
		f.notifyTheme()
		expect(runtimes[0].themeUpdates).toBe(1)
		expect(f.themeListeners.size).toBe(1)

		await f.view.onClose()
		expect(runtimes[0].destroyed).toBe(true)
		expect(f.themeListeners.size).toBe(0)
		expect(f.storeListeners.size).toBe(0)
	})

	it('detaches the leaf when the AI module is inactive', async () => {
		const f = fixture()
		;(f.plugin.ai.lifecycle as { active: boolean }).active = false
		await f.view.onOpen()
		expect(f.leaf.detach).toHaveBeenCalled()
		expect(f.workspaces.load).not.toHaveBeenCalled()
	})
})

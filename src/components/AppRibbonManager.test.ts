// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModuleScope } from '~/modules/lifecycle'
import type NutstorePlugin from '~/index'
import type { SavedApp } from '~/ai/apps/domain'
import type { AppStore } from '~/ai/apps/store'
import AppRibbonManager from './AppRibbonManager'

const icons = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }))
const logger = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('obsidian', () => ({ addIcon: icons.add, removeIcon: icons.remove }))
vi.mock('~/utils/logger', () => ({ default: logger }))

function savedApp(
	overrides: {
		title?: string
		iconSvg?: string
		pinned?: boolean
	} = {},
): SavedApp {
	return {
		id: 'app-neutral',
		manifest: {
			schemaVersion: 1,
			title: overrides.title ?? '中性工具 Neutral tool 🌿',
			iconSvg:
				overrides.iconSvg ??
				'<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="currentColor"/></svg>',
			dataVersion: 1,
		},
		state: {
			schemaVersion: 1,
			pinned: overrides.pinned ?? true,
			createdAt: 1_000,
			updatedAt: 2_000,
		},
	}
}

function fixture() {
	const saved = savedApp()
	// eslint-disable-next-line obsidianmd/prefer-create-el -- Unit tests do not load Obsidian's DOM extensions.
	const host = document.createElement('div')
	document.body.append(host)
	const commands = new Map<
		string,
		{ name: string; checkCallback(checking: boolean): boolean }
	>()
	const openApp = vi.fn(async () => {})
	const plugin = {
		manifest: { id: 'neutral-plugin' },
		register: vi.fn(),
		app: { workspace: { containerEl: host } },
		ai: { openApp },
		addRibbonIcon: vi.fn((_icon: string, label: string, run: () => void) => {
			// eslint-disable-next-line obsidianmd/prefer-create-el -- Mock the host ribbon factory with the standard DOM API.
			const el = document.createElement('button')
			el.setAttribute('aria-label', label)
			el.addEventListener('click', run)
			host.append(el)
			return el
		}),
		addCommand: vi.fn(
			(command: {
				id: string
				name: string
				checkCallback(checking: boolean): boolean
			}) => {
				commands.set(command.id, command)
			},
		),
		removeCommand: vi.fn((id: string) => commands.delete(id)),
	} as unknown as NutstorePlugin
	const listeners = new Set<(appId?: string) => void>()
	const items: Array<{ id: string; app?: SavedApp; error?: string }> = [
		{ id: saved.id, app: saved },
	]
	const store = {
		list: vi.fn(async () => items),
		subscribe: (listener: (appId?: string) => void) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	} as unknown as AppStore
	const scope = new ModuleScope()
	const manager = new AppRibbonManager(plugin, scope, store)
	return {
		saved,
		host,
		scope,
		commands,
		openApp,
		plugin,
		store,
		manager,
		items,
		listeners,
	}
}

afterEach(() => {
	vi.clearAllMocks()
	document.body.replaceChildren()
})

describe('independent App ribbon integration', () => {
	it('registers the pinned App SVG, command and open callback by stable id', async () => {
		const f = fixture()
		await f.manager.refresh()
		await f.manager.refresh()

		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(1)
		expect(f.plugin.addRibbonIcon).toHaveBeenCalledWith(
			'nutstore-app-app-neutral',
			'中性工具 Neutral tool 🌿',
			expect.any(Function),
		)
		expect(icons.add).toHaveBeenCalledWith(
			'nutstore-app-app-neutral',
			expect.stringContaining('circle'),
		)
		const command = f.commands.get('open-app-app-neutral')!
		expect(command.name).toBe('中性工具 Neutral tool 🌿')
		expect(command.checkCallback(true)).toBe(true)

		;(f.host.querySelector('button') as HTMLButtonElement).click()
		await vi.waitFor(() =>
			expect(f.openApp).toHaveBeenCalledWith('app-neutral'),
		)
	})

	it('removes ribbon, command and icon on unpin, delete and module shutdown', async () => {
		const f = fixture()
		await f.manager.refresh()
		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(1)

		// Unpinning removes the ribbon but keeps the App openable through its command.
		f.saved.state.pinned = false
		await f.manager.refresh()
		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(0)
		expect(f.commands.size).toBe(1)
		expect(icons.remove).toHaveBeenCalledWith('nutstore-app-app-neutral')

		// Deleting the App removes its remaining command and icon.
		f.items.length = 0
		icons.remove.mockClear()
		await f.manager.refresh()
		expect(f.commands.size).toBe(0)
		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(0)
		expect(icons.remove).toHaveBeenCalledWith('nutstore-app-app-neutral')
	})

	it('drops every registration when its module scope closes', async () => {
		const f = fixture()
		f.scope.close()
		const scope = new ModuleScope()
		const manager = new AppRibbonManager(f.plugin, scope, f.store)
		await manager.refresh()
		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(1)

		scope.close()
		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(0)
		expect(f.commands.size).toBe(0)
		expect(icons.remove).toHaveBeenCalledWith('nutstore-app-app-neutral')
	})

	it('re-registers when title or icon changes and keeps one ribbon entry', async () => {
		const f = fixture()
		await f.manager.refresh()
		expect(f.plugin.addRibbonIcon).toHaveBeenCalledOnce()

		f.saved.manifest.title = '中性工具更新 neutral update 🌿'
		await f.manager.refresh()
		expect(f.plugin.addRibbonIcon).toHaveBeenCalledTimes(2)
		expect(f.plugin.removeCommand).toHaveBeenCalledWith('open-app-app-neutral')
		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(1)
		expect(f.commands.get('open-app-app-neutral')?.name).toBe(
			'中性工具更新 neutral update 🌿',
		)

		// An unchanged model is a no-op refresh.
		await f.manager.refresh()
		expect(f.plugin.addRibbonIcon).toHaveBeenCalledTimes(2)
	})

	it('skips an App whose manifest icon is not inert SVG and reports it', async () => {
		const f = fixture()
		f.items.push({
			id: 'app-invalid-icon',
			app: {
				...savedApp(),
				id: 'app-invalid-icon',
				manifest: {
					...savedApp().manifest,
					iconSvg: '<svg viewBox="0 0 100 100"><script>1</script></svg>',
				},
			},
		})
		await f.manager.refresh()

		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(1)
		expect(f.commands.has('open-app-app-invalid-icon')).toBe(false)
		expect(logger.error).toHaveBeenCalled()
	})

	it('ignores listing entries without a readable App', async () => {
		const f = fixture()
		f.items.push({ id: 'org.example.broken', error: 'Invalid App manifest' })
		await f.manager.refresh()
		expect(f.commands.has('open-app-org.example.broken')).toBe(false)
		expect(f.host.querySelectorAll('[data-nutstore-app-id]')).toHaveLength(1)
	})
})

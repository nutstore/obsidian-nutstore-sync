import { ModuleState } from '~/modules/lifecycle'
import { ChatboxLocation, SessionAppOpenMode } from '~/settings'
import ScanIssuesModal from '~/components/ScanIssuesModal'
import { ChatWorkspacePanel } from '~/components/ChatWorkspacePanel'
import { APP_VIEW_TYPE } from '~/views/app.view'
import { createModelConfig, createProviderConfig } from '~/ai/catalog/config'
import { requireApiVersion, type App } from 'obsidian'
import type NutstorePlugin from '~/index'
import type { SyncRunSnapshot } from '~/services/progress.service'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'
import { CHATBOX_VIEW_TYPE } from '~/views/chatbox.view'
import { assert } from './assert'
import { assertViewAboveMobileNavigation } from './mobile-navigation'

type ProductionPlugin = NutstorePlugin

function getProductionPlugin(app: App): ProductionPlugin {
	const plugins = (
		app as unknown as { plugins: { plugins: Record<string, unknown> } }
	).plugins
	const plugin = plugins.plugins['nutstore-sync'] as
		ProductionPlugin | undefined
	assert(plugin, 'Nutstore Sync is not loaded')
	return plugin
}

export async function loadsProductionPlugin(app: App) {
	getProductionPlugin(app)
}

export async function opensChatboxInChosenLocation(app: App) {
	const plugin = getProductionPlugin(app)
	const original = plugin.localSettings.ai.chatboxLocation
	const originalProviders = plugin.settings.ai.providers
	const originalDefaultModel = plugin.settings.ai.defaultModel
	const provider = createProviderConfig({
		id: 'chosen-location-provider',
		name: 'Location provider / 位置服务 🌱',
		api: 'https://example.test/v1',
		apiKey: 'neutral-key',
		models: {
			'neutral-model': createModelConfig({
				id: 'neutral-model',
				name: 'Neutral model / 中性模型 🌱',
			}),
		},
	})
	plugin.settings.ai.providers = {
		...originalProviders,
		[provider.id]: provider,
	}
	plugin.settings.ai.defaultModel = {
		providerId: provider.id,
		modelId: 'neutral-model',
	}
	await plugin.ai.chat.ensureSession()
	const draft = 'Neutral draft / 中性草稿 🌱'
	const sessionId = plugin.ai.chat.getViewProps().activeSessionId
	plugin.ai.chat.updateInputDraft(draft)
	try {
		await plugin.settingsService.saveSettings()
		for (const location of [
			ChatboxLocation.Sidebar,
			ChatboxLocation.Editor,
			ChatboxLocation.Sidebar,
		]) {
			plugin.localSettings.ai.chatboxLocation = location
			await plugin.ai.openChatbox()
			const leaves = app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)
			assert(leaves.length === 1, 'Changing location duplicated the Chatbox')
			const leaf = leaves[0]!
			assert(
				leaf.getRoot() ===
					(location === ChatboxLocation.Editor
						? app.workspace.rootSplit
						: app.workspace.rightSplit),
				'Chatbox opened in the wrong workspace area',
			)
			await plugin.ai.openChatbox()
			assert(
				app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0] === leaf,
				'Reopening replaced the existing Chatbox',
			)
			const props = plugin.ai.chat.getViewProps()
			assert(
				props.activeSessionId === sessionId,
				'Moving Chatbox changed its session',
			)
			assert(
				props.draft.text === draft,
				'Moving Chatbox lost its Unicode draft',
			)
		}
	} finally {
		plugin.localSettings.ai.chatboxLocation = original
		plugin.settings.ai.providers = originalProviders
		plugin.settings.ai.defaultModel = originalDefaultModel
		await plugin.settingsService.saveSettings()
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
	}
}

export async function opensProviderSetupInEditorThenMovesChatboxToChosenLocation(
	app: App,
) {
	const plugin = getProductionPlugin(app)
	const originalLocation = plugin.localSettings.ai.chatboxLocation
	const originalProviders = plugin.settings.ai.providers
	const originalDefaultModel = plugin.settings.ai.defaultModel
	const provider = createProviderConfig({
		id: 'setup-location-provider',
		name: 'Setup provider / 配置服务 🌱',
		api: 'https://example.test/v1',
		apiKey: 'neutral-key',
		models: {
			'neutral-model': createModelConfig({
				id: 'neutral-model',
				name: 'Neutral model / 中性模型 🌱',
			}),
		},
	})

	try {
		plugin.localSettings.ai.chatboxLocation = ChatboxLocation.Sidebar
		plugin.settings.ai.providers = {}
		plugin.settings.ai.defaultModel = undefined
		await plugin.settingsService.saveSettings()
		await plugin.ai.chat.ensureSession()
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)

		await plugin.ai.openChatbox()
		const setupLeaf = app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]
		assert(setupLeaf, 'Provider setup did not open the Chatbox')
		assert(
			setupLeaf.getRoot() === app.workspace.rootSplit,
			'Provider setup ignored its dedicated editor location',
		)

		plugin.settings.ai.providers = {
			...originalProviders,
			[provider.id]: provider,
		}
		plugin.settings.ai.defaultModel = {
			providerId: provider.id,
			modelId: 'neutral-model',
		}
		await plugin.settingsService.saveSettings()

		const deadline = performance.now() + 2_000
		while (performance.now() < deadline) {
			const leaves = app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)
			if (
				leaves.length === 1 &&
				leaves[0]?.getRoot() === app.workspace.rightSplit
			) {
				break
			}
			await new Promise<void>((resolve) => window.setTimeout(resolve, 25))
		}

		const configuredLeaves = app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)
		assert(
			configuredLeaves.length === 1,
			'Completing provider setup duplicated the Chatbox',
		)
		assert(
			configuredLeaves[0]?.getRoot() === app.workspace.rightSplit,
			'Completing provider setup ignored the chosen Chatbox location',
		)
	} finally {
		plugin.localSettings.ai.chatboxLocation = originalLocation
		plugin.settings.ai.providers = originalProviders
		plugin.settings.ai.defaultModel = originalDefaultModel
		await plugin.settingsService.saveSettings()
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
	}
}

/** Run with a ready (neutral) provider so the real composer renders its workspace controls. */
async function withNeutralProvider(
	plugin: ReturnType<typeof getProductionPlugin>,
	run: () => Promise<void>,
) {
	const originalLocation = plugin.localSettings.ai.chatboxLocation
	const originalProviders = plugin.settings.ai.providers
	const originalDefaultModel = plugin.settings.ai.defaultModel
	const provider = createProviderConfig({
		id: 'neutral-provider',
		name: 'Neutral provider / 中性服务 🌱',
		api: 'https://example.test/v1',
		apiKey: 'neutral-key',
		models: {
			'neutral-model': createModelConfig({
				id: 'neutral-model',
				name: 'Neutral model / 中性模型 🌱',
			}),
		},
	})
	plugin.settings.ai.providers = {
		...originalProviders,
		[provider.id]: provider,
	}
	plugin.settings.ai.defaultModel = {
		providerId: provider.id,
		modelId: 'neutral-model',
	}
	try {
		await plugin.settingsService.saveSettings()
		await plugin.ai.chat.ensureSession()
		await run()
	} finally {
		plugin.localSettings.ai.chatboxLocation = originalLocation
		plugin.settings.ai.providers = originalProviders
		plugin.settings.ai.defaultModel = originalDefaultModel
		await plugin.settingsService.saveSettings()
	}
}

/** Exercise the actual composer against Obsidian's phone navigation CSS. */
export async function keepsChatboxAboveMobileNavigation(app: App) {
	const plugin = getProductionPlugin(app)
	await withNeutralProvider(plugin, async () => {
		plugin.ai.chat.updateInputDraft('Neutral message / 中性消息 🌱')
		for (const location of [ChatboxLocation.Editor, ChatboxLocation.Sidebar]) {
			plugin.localSettings.ai.chatboxLocation = location
			await plugin.ai.openChatbox()
			const view = app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]!.view
			try {
				await assertViewAboveMobileNavigation(view, '.ns-composer-send')
			} finally {
				app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
			}
		}
	})
}

/** A press on the composer refreshes view props; it must not rebuild the workspace picker under the pointer. */
export async function keepsWorkspacePickerAcrossPointerDown(app: App) {
	const plugin = getProductionPlugin(app)
	await withNeutralProvider(plugin, async () => {
		plugin.localSettings.ai.chatboxLocation = ChatboxLocation.Sidebar
		await plugin.ai.openChatbox()
		try {
			const root =
				app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]!.view.containerEl
			const picker = root.querySelector<HTMLButtonElement>(
				'.ns-workspace-picker',
			)
			assert(picker, 'Workspace picker is unavailable')
			picker.dispatchEvent(
				new PointerEvent('pointerdown', { bubbles: true, composed: true }),
			)
			await new Promise((resolve) => window.setTimeout(resolve, 50))
			assert(
				picker.isConnected &&
					root.querySelector('.ns-workspace-picker') === picker,
				'Workspace picker was rebuilt by pointer down',
			)
		} finally {
			app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
		}
	})
}

export async function respectsSessionAppOpenMode(app: App) {
	const plugin = getProductionPlugin(app)
	const originalMode = plugin.localSettings.ai.sessionAppOpenMode
	const originalLocation = plugin.localSettings.ai.chatboxLocation
	const id = 'org.example.session_opening'
	app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
	await plugin.ai.workspaces.create(id, '中性工具 Neutral tool 🌱')
	await plugin.ai.chat.ensureSession()
	await plugin.ai.chat.selectWorkspace(id)
	const sessionId = plugin.ai.chat.workspaceState.sessionId!
	const originalOpen = plugin.ai.openApp
	let pending: Promise<unknown>[] = []
	plugin.ai.openApp = (appId) => {
		const opened = originalOpen.call(plugin.ai, appId)
		pending.push(opened)
		return opened
	}
	const host = app.workspace.containerEl.createDiv()
	try {
		for (const location of [ChatboxLocation.Sidebar, ChatboxLocation.Editor]) {
			plugin.localSettings.ai.chatboxLocation = location
			for (const mode of [
				SessionAppOpenMode.Manual,
				SessionAppOpenMode.Automatic,
			]) {
				plugin.localSettings.ai.sessionAppOpenMode = mode
				pending = []
				const panel = new ChatWorkspacePanel(host, plugin)
				try {
					await Promise.all(pending)
					assert(
						pending.length === (mode === SessionAppOpenMode.Automatic ? 1 : 0),
						'Session App opening ignored the independent device preference',
					)
					assert(
						plugin.ai.chat.activeAppId === id,
						'Manual opening cleared the session App binding',
					)
					await plugin.ai.openApp(id)
					assert(
						app.workspace.getLeavesOfType(APP_VIEW_TYPE).length === 1,
						'Explicit App opening failed or duplicated its view',
					)
					const count = pending.length
					await plugin.ai.chat.switchSession(sessionId)
					assert(pending.length === count, 'A session update reopened its App')
				} finally {
					panel.destroy()
					app.workspace.detachLeavesOfType(APP_VIEW_TYPE)
				}
			}
		}
	} finally {
		host.remove()
		plugin.ai.openApp = originalOpen
		plugin.localSettings.ai.sessionAppOpenMode = originalMode
		plugin.localSettings.ai.chatboxLocation = originalLocation
		await plugin.ai.chat.selectWorkspace(undefined)
		await plugin.ai.workspaces.remove(id)
	}
}

export async function listsOnlyVaultSkillsInSettings(
	app: App,
	recordStep: (step: LifecycleStep) => Promise<void>,
) {
	const step = createCheckStep(recordStep)
	const plugin = getProductionPlugin(app)
	const { settingTab } = plugin
	const { BUILTIN_SKILLS } = await import('~/ai/skills/builtin')
	const { SKILLS_ROOT } = await import('~/ai/skills/repository')
	const skillDir = `${SKILLS_ROOT}/settings-probe-skill`
	const originalDisabled = [...plugin.settings.ai.disabledSkills]
	const originalSave = plugin.settingsService.saveSettings
	let pendingSave: Promise<void> | undefined
	const host = (
		app as unknown as {
			setting: { open(): void; close(): void; openTabById(id: string): void }
		}
	).setting
	const adapter = app.vault.adapter

	await step('Skills: prepare Vault fixture', async () => {
		if (!(await adapter.exists(SKILLS_ROOT))) await adapter.mkdir(SKILLS_ROOT)
		await adapter.mkdir(skillDir)
		await adapter.write(
			`${skillDir}/SKILL.md`,
			'---\nname: settings-probe-skill\ndescription: Neutral Skill / 中性技能 🌱\n---\n',
		)
	})

	try {
		plugin.settings.ai.disabledSkills = originalDisabled.filter(
			(name) => name !== 'settings-probe-skill',
		)
		plugin.settingsService.saveSettings = function () {
			pendingSave = originalSave.call(this)
			return pendingSave
		}
		await step('Skills: open settings', () => {
			host.open()
			host.openTabById('nutstore-sync')
		})
		const section = settingTab.skillSettings
		section.containerEl.show()
		await step('Skills: render initial catalog', () => section.display())
		const settingsText = section.containerEl.textContent ?? ''
		assert(
			settingsText.includes('settings-probe-skill'),
			'Skills settings did not list a Vault Skill',
		)
		for (const skill of BUILTIN_SKILLS) {
			assert(
				!settingsText.includes(skill.name),
				`Skills settings listed built-in Skill '${skill.name}'`,
			)
		}
		assert(
			settingsText.includes('Neutral Skill / 中性技能 🌱'),
			'Skills settings did not preserve the UTF-8 description',
		)
		for (const enabled of [false, true]) {
			const row = Array.from(
				section.containerEl.querySelectorAll('.setting-item'),
			).find(
				(element) =>
					element.querySelector('.setting-item-name')?.textContent ===
					'settings-probe-skill',
			)
			const toggle = row?.querySelector<HTMLElement>('.checkbox-container')
			assert(toggle, 'Vault Skill toggle was not rendered')
			assert(
				toggle.classList.contains('is-enabled') === !enabled,
				'Toggle did not reflect the saved state',
			)
			pendingSave = undefined
			const input = toggle.querySelector<HTMLInputElement>(
				'input[type="checkbox"]',
			)
			assert(input, 'Skill toggle has no checkbox input')
			await step(
				`Skills: save ${enabled ? 'enabled' : 'disabled'}`,
				async () => {
					input.click()
					assert(pendingSave, 'Toggling a Skill did not save settings')
					await pendingSave
				},
			)
			const stored = (await plugin.loadData()) as {
				ai: { disabledSkills: string[] }
			}
			assert(
				stored.ai.disabledSkills.includes('settings-probe-skill') === !enabled,
				'Skill activation was not persisted',
			)
			await step('Skills: render saved catalog', () => section.display())
			const renderedToggle = section.containerEl.querySelector<HTMLElement>(
				'.checkbox-container',
			)
			assert(
				renderedToggle?.classList.contains('is-enabled') === enabled,
				'Rendered toggle did not reflect the persisted activation',
			)
		}
	} finally {
		host.close()
		plugin.settingsService.saveSettings = originalSave
		plugin.settings.ai.disabledSkills = originalDisabled
		await step('Skills: restore settings', () =>
			originalSave.call(plugin.settingsService),
		)
		// This fixture is flat. Remove its file explicitly so the host's recursive
		// rm has no child-file traversal, which can stall in the guest.
		await step('Skills: remove fixture file', () =>
			adapter.remove(`${skillDir}/SKILL.md`),
		)
		await step('Skills: remove empty fixture directory', () =>
			adapter.rmdir(skillDir, true),
		)
	}
}

export async function reloadsProductionPlugin(app: App) {
	const plugins = (
		app as unknown as {
			plugins: {
				disablePlugin(id: string): Promise<void>
				enablePlugin(id: string): Promise<void>
				plugins: Record<string, unknown>
			}
		}
	).plugins
	await plugins.disablePlugin('nutstore-sync')
	await plugins.enablePlugin('nutstore-sync')
	assert(
		plugins.plugins['nutstore-sync'],
		'Production plugin did not reload through the real lifecycle',
	)
}

export interface LifecycleStep {
	name: string
	status: 'started' | 'completed' | 'failed'
	startedAt: string
	elapsedMs: number
}

function createCheckStep(recordStep: (step: LifecycleStep) => Promise<void>) {
	// Persist before invoking each operation so even a blocked renderer leaves
	// the exact pending call in the guest diagnostics.
	return async (name: string, operation: () => void | Promise<void>) => {
		const startedAt = new Date().toISOString()
		await recordStep({ name, status: 'started', startedAt, elapsedMs: 0 })
		const start = performance.now()
		try {
			await operation()
		} catch (error) {
			await recordStep({
				name,
				status: 'failed',
				startedAt,
				elapsedMs: performance.now() - start,
			})
			throw error
		}
		await recordStep({
			name,
			status: 'completed',
			startedAt,
			elapsedMs: performance.now() - start,
		})
	}
}

export async function detachesChatboxWhenProductionPluginIsDisabled(
	app: App,
	recordStep: (step: LifecycleStep) => Promise<void>,
) {
	const step = createCheckStep(recordStep)
	const plugins = (
		app as unknown as {
			plugins: {
				disablePluginAndSave(id: string): Promise<void>
				enablePluginAndSave(id: string): Promise<boolean>
			}
		}
	).plugins
	const plugin = getProductionPlugin(app)
	await step('openChatbox: initial', () => plugin.ai.openChatbox())
	await step('assert: initial ChatBox count', () => {
		assert(
			app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 1,
			'ChatBox view did not open before the production plugin was disabled',
		)
	})

	// Match the Settings toggle: plain disablePlugin preserves leaves for reload.
	await step('disablePluginAndSave', () =>
		plugins.disablePluginAndSave('nutstore-sync'),
	)
	try {
		await step('assert: ChatBox detached', () => {
			assert(
				app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 0,
				'ChatBox view remained attached after the production plugin was disabled',
			)
		})
	} finally {
		await step('enablePluginAndSave', async () => {
			assert(
				await plugins.enablePluginAndSave('nutstore-sync'),
				'Production plugin failed to re-enable',
			)
		})
	}

	const reloadedPlugin = getProductionPlugin(app)
	try {
		await step('openChatbox: reloaded', () => reloadedPlugin.ai.openChatbox())
		await step('assert: no duplicate ChatBox', () => {
			assert(
				app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 1,
				'Production plugin created duplicate ChatBox views after it was re-enabled',
			)
		})
	} finally {
		await step('detachLeavesOfType: cleanup', () =>
			app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE),
		)
	}
}

export async function rendersSyncProgress(app: App) {
	const plugin = getProductionPlugin(app)
	const progress = plugin.sync.progress
	const language = plugin.settings.language
	const previousRun = progress.run
	const syncing: SyncRunSnapshot = {
		status: 'syncing',
		startedAt: Date.now(),
		preparation: null,
		total: 0,
		completed: [],
		current: null,
		currentInFlight: false,
		failedCount: 0,
		scanIssues: [],
	}
	progress.run = syncing

	try {
		progress.showProgressModal()
		const modal = document.querySelector('.modal.nutstore-sync-progress-modal')
		assert(modal instanceof HTMLElement, 'Sync progress modal did not open')
		assert(
			modal.querySelector('.nutstore-sync-progress__status-icon--syncing'),
			'Sync progress modal did not render syncing state',
		)

		progress.run = { ...syncing, status: 'complete', endedAt: Date.now() }
		progress.updateModal()
		progress.updateModal.flush?.()

		assert(
			modal.querySelector('.nutstore-sync-progress__status-icon--complete'),
			'Sync progress modal did not render complete state',
		)
		const progressLabel = modal.querySelector(
			'.nutstore-sync-progress__bar-label',
		)
		assert(
			progressLabel?.textContent?.includes('100'),
			'Sync progress modal did not show 100% for an empty completed sync',
		)
		const stopButton = modal.querySelector(
			'.nutstore-sync-progress__footer button',
		)
		assert(
			stopButton instanceof HTMLButtonElement &&
				window.getComputedStyle(stopButton).display === 'none',
			`Sync progress modal kept its stop control after completion: ${stopButton?.outerHTML ?? 'missing'}`,
		)
		for (const locale of ['zh', 'en'] as const) {
			plugin.settings.language = locale
			await plugin.i18nService.update()
			const path = 'Notes 笔记🌱/Section & <draft>📘'
			progress.run = {
				...syncing,
				status: 'warning',
				endedAt: Date.now(),
				scanIssues: [
					{
						path,
						operation: 'list',
						cause: new Error('Unavailable 暂不可用🌿'),
					},
				],
			}
			progress.updateModal()
			progress.updateModal.flush?.()
			assert(
				modal.querySelector('.nutstore-sync-progress__status-icon--warning'),
				'Production progress did not warn about the partial scan',
			)
			const title = modal.querySelector('.nutstore-sync-progress__title-text')
			const titleCopy = (locale === 'zh' ? zh : en).sync.partialScanTitle
			assert(
				title?.textContent === titleCopy,
				`Production progress title should stay short: ${title?.textContent}`,
			)
			assert(
				!title.textContent?.includes(path),
				'Production progress title duplicated the path list owned by the scan issues dialog',
			)
			const summary = modal.querySelector(
				'.nutstore-sync-progress__scan-issues',
			)
			assert(
				summary instanceof HTMLElement && summary.textContent?.includes('1'),
				'Production progress lost the unavailable path count from its body',
			)
			const viewButton = summary.querySelector('button')
			assert(
				viewButton instanceof HTMLButtonElement &&
					viewButton.textContent ===
						(locale === 'zh' ? zh : en).scanIssues.view,
				`Production progress has no button for the scan issues list: ${summary.outerHTML}`,
			)
			assert(
				!document.querySelector('.scan-issues-modal'),
				'Scan issues dialog opened over the visible progress dialog',
			)
			viewButton.click()
			const issuesModal = document.querySelector('.scan-issues-modal')
			assert(issuesModal, 'The progress dialog button did not open the list')
			assert(
				issuesModal.textContent?.includes(path),
				'The opened list lost the unavailable path',
			)
			;[...issuesModal.querySelectorAll('button')].at(-1)?.click()
			assert(
				!document.querySelector('.scan-issues-modal'),
				'Scan issues dialog did not close from its close button',
			)
			document.body.classList.add('is-phone')
			modal.style.setProperty('--dialog-width', '390px')
			modal.style.setProperty('--dialog-max-width', '390px')
			progress.updateModal.flush?.()
			assert(
				(title as HTMLElement).scrollWidth <=
					(title as HTMLElement).clientWidth + 1,
				`Production progress title is truncated on a phone: ${(title as HTMLElement).scrollWidth}/${(title as HTMLElement).clientWidth}`,
			)
			const summaryBox = summary.getBoundingClientRect()
			const modalBox = modal.getBoundingClientRect()
			assert(
				summaryBox.left >= modalBox.left - 1 &&
					summaryBox.right <= modalBox.right + 1 &&
					(viewButton.getBoundingClientRect().right ?? 0) <= modalBox.right + 1,
				'Production progress scan summary overflows a phone dialog',
			)
			document.body.classList.remove('is-phone')
			modal.removeAttribute('style')
			assert(
				!modal.querySelector('.nutstore-sync-progress__status-icon--complete'),
				'Production progress reported partial scanning as fully complete',
			)
			progress.run = { ...syncing, status: 'complete', endedAt: Date.now() }
			progress.updateModal()
			progress.updateModal.flush?.()
			assert(
				modal.querySelector('.nutstore-sync-progress__status-icon--complete'),
				'Production progress kept a stale scan warning after recovery',
			)
		}

		// The outcome of a finished run stays reachable after the dialog closes.
		progress.closeProgressModal()
		assert(
			!document.querySelector('.modal.nutstore-sync-progress-modal'),
			'Sync progress modal did not close',
		)
		progress.showProgressModal()
		assert(
			document.querySelector(
				'.modal.nutstore-sync-progress-modal .nutstore-sync-progress__status-icon--complete',
			),
			'Reopened sync progress did not show the finished run',
		)
	} finally {
		plugin.settings.language = language
		await plugin.i18nService.update()
		progress.closeProgressModal()
		progress.run = previousRun
	}
}

export async function listsUnscannedPathsInLargeModal(app: App) {
	const paths = ['Notes 笔记🌱/Section & <draft>📘', 'Archive/資料 🌿.md']
	const modal = new ScanIssuesModal(app, [
		{
			path: paths[0],
			operation: 'list',
			cause: new Error('Unavailable 暂不可用🌿'),
		},
		{ path: paths[1], operation: 'stat', cause: 'plain failure 失败' },
	])
	modal.open()
	try {
		assert(
			modal.modalEl.classList.contains('mod-lg'),
			'Scan issues dialog did not use the large modal size',
		)
		const rows = [...modal.contentEl.querySelectorAll('.scan-issues-item')]
		assert(
			rows.length === 2,
			`Expected two scan issue rows, got ${rows.length}`,
		)
		// Rows are ordered by path.
		;[...paths]
			.sort()
			.forEach((path, index) =>
				assert(
					rows[index].querySelector('.scan-issues-path')?.textContent === path,
					`Scan issue row ${index} lost its Unicode path`,
				),
			)
		assert(
			!modal.contentEl.querySelector('draft'),
			'Scan issues dialog interpreted a path as HTML',
		)
		assert(
			modal.modalEl.isConnected && modal.contentEl.querySelector('button'),
			'Scan issues dialog is not mounted with a close button',
		)
	} finally {
		modal.close()
	}
	assert(
		!modal.modalEl.isConnected,
		'Scan issues dialog stayed open after close',
	)
}

export async function opensTenThousandUnscannedPathsWithoutFreezing(app: App) {
	const issues = Array.from({ length: 10_000 }, (_, index) => ({
		path: `目录 Folder ${String(index).padStart(5, '0')}🌱/子目录 Sub 📘`,
		operation: 'list' as const,
		cause: new Error(
			`EACCES: permission denied, scandir '/vault 库/目录 Folder ${String(index).padStart(5, '0')}🌱/子目录 Sub 📘'`,
		),
	}))
	const modal = new ScanIssuesModal(app, issues)
	const started = performance.now()
	modal.open()
	try {
		await new Promise<void>((resolve) =>
			window.requestAnimationFrame(() =>
				window.requestAnimationFrame(() => resolve()),
			),
		)
		const untilPainted = performance.now() - started
		const items = () => modal.contentEl.querySelectorAll('.scan-issues-item')
		assert(
			untilPainted < 1500,
			`10000 unscanned paths froze the UI for ${Math.round(untilPainted)}ms`,
		)
		const list =
			modal.contentEl.querySelector<HTMLElement>('.scan-issues-list')!
		const spacer = modal.contentEl.querySelector<HTMLElement>(
			'.scan-issues-spacer',
		)!
		assert(
			items().length > 0 && items().length < 200,
			`Expected a window of rows, got ${items().length} of 10000`,
		)
		assert(
			spacer.offsetHeight >= 10_000 * 40 &&
				list.scrollHeight >= spacer.offsetHeight,
			`Scroll area does not cover all rows: ${spacer.offsetHeight}/${list.scrollHeight}`,
		)
		list.scrollTop = list.scrollHeight
		await new Promise<void>((resolve) =>
			window.requestAnimationFrame(() =>
				window.requestAnimationFrame(() => resolve()),
			),
		)
		const last = issues.at(-1)!.path
		assert(
			[...modal.contentEl.querySelectorAll('.scan-issues-path')].some(
				(el) => el.textContent === last,
			),
			'Scrolling to the end did not reveal the last unscanned path',
		)
		assert(
			items().length < 200,
			`Scrolling left ${items().length} rows mounted`,
		)
		const close = [...modal.contentEl.querySelectorAll('button')].at(-1)!
		const box = modal.modalEl.getBoundingClientRect()
		assert(
			close.getBoundingClientRect().bottom <= box.bottom + 1,
			'Close button was pushed out of the dialog by a long list',
		)
	} finally {
		modal.close()
	}
}

export async function keepsUnscannedPathsDialogUsableOnPhone(app: App) {
	const issues = Array.from({ length: 14 }, (_, index) => ({
		path: `Notes 笔记🌱/很长的章节名称 Section ${index}/${'UnbrokenSegment'.repeat(8)}🌿无空格/${'嵌套 Nested '.repeat(3)}`,
		operation: 'list' as const,
		cause: new Error('Unavailable 暂不可用🌿'),
	}))
	const modal = new ScanIssuesModal(app, issues)
	document.body.classList.add('is-phone')
	modal.open()
	// The host defines the dialog box variables on the modal itself; give it
	// phone dimensions there, as a real phone does with its screen size.
	modal.modalEl.style.setProperty('--dialog-width', '390px')
	modal.modalEl.style.setProperty('--dialog-max-width', '390px')
	modal.modalEl.style.setProperty('--dialog-max-height', '600px')
	try {
		await new Promise<void>((resolve) =>
			window.requestAnimationFrame(() =>
				window.requestAnimationFrame(() => resolve()),
			),
		)
		const box = modal.modalEl.getBoundingClientRect()
		assert(
			box.width <= 391 && box.height <= 601,
			`Scan issues dialog exceeded the phone dialog box: ${box.width}x${box.height}`,
		)
		const list =
			modal.contentEl.querySelector<HTMLElement>('.scan-issues-list')!
		assert(
			list.scrollHeight > list.clientHeight &&
				getComputedStyle(list).overflowY === 'auto',
			'Scan issues list did not scroll inside the phone dialog',
		)
		const buttons = [
			...modal.contentEl.querySelectorAll<HTMLElement>(
				'.scan-issues-actions button',
			),
		]
		assert(
			buttons.length === 2,
			`Expected two action buttons, got ${buttons.length}`,
		)
		for (const button of buttons) {
			const buttonBox = button.getBoundingClientRect()
			assert(
				buttonBox.height >= 30 &&
					buttonBox.bottom <= box.bottom &&
					buttonBox.left >= box.left &&
					buttonBox.right <= box.right,
				`Action button does not fit the phone dialog: button ${JSON.stringify(buttonBox)} dialog ${JSON.stringify(box)}`,
			)
		}
		assert(
			list.clientHeight >= box.height * 0.4,
			`Scan issues list wasted the phone dialog height: ${list.clientHeight}/${box.height}`,
		)
		const overflow = Math.max(
			modal.contentEl.scrollWidth - modal.contentEl.clientWidth,
			list.scrollWidth - list.clientWidth,
		)
		assert(
			overflow <= 1,
			`Scan issues dialog scrolled sideways by ${overflow}px`,
		)
	} finally {
		modal.close()
		document.body.classList.remove('is-phone')
	}
}

export async function rendersSearchableSettings(app: App) {
	if (requireApiVersion('1.13.0')) {
		const { settingTab } = getProductionPlugin(app)
		// Exercise the real host search index and navigation, not a mock renderer.
		const host = (
			app as unknown as {
				setting: {
					open(): void
					close(): void
					openTabById(id: string): void
					searchComponent: { setValue(value: string): void }
					onSearchChanged(): void
					searchResultsEl: HTMLElement
				}
			}
		).setting
		const language = settingTab.plugin.settings.language
		host.open()
		try {
			for (const [locale, labels] of [
				['en', en],
				['zh', zh],
			] as const) {
				settingTab.plugin.settings.language = locale
				await settingTab.plugin.i18nService.update()
				settingTab.update()
				host.openTabById('nutstore-sync')
				await new Promise((resolve) => window.setTimeout(resolve, 100))
				const container = settingTab.containerEl
				const buttons = () =>
					Array.from(
						container.querySelectorAll<HTMLButtonElement>('.ns-settings-tab'),
					)
				assert(buttons().length === 3, 'Settings did not render three tabs')
				assert(
					!buttons()[0].closest('.setting-items'),
					'Tab navigation is nested inside the native settings card',
				)
				const expectedHeadingsByTab = [
					[
						labels.settings.sections.account,
						labels.settings.sections.sync,
						labels.settings.sections.automation,
						labels.settings.sections.transfer,
						labels.settings.sections.interface,
						labels.settings.sections.filters,
					],
					[
						labels.settings.sections.ai,
						labels.settings.ai.memory.heading,
						labels.settings.ai.subagents.heading,
						labels.settings.ai.skills.heading,
						labels.settings.ai.preferences,
					],
					[labels.settings.troubleshooting.title],
				]
				for (const [
					tabIndex,
					expectedHeadings,
				] of expectedHeadingsByTab.entries()) {
					buttons()[tabIndex].click()
					const visibleHeadings = Array.from(
						container.querySelectorAll<HTMLElement>(
							'.setting-item.setting-item-heading',
						),
					)
						.filter((heading) => heading.offsetHeight > 0)
						.map((heading) => heading.textContent?.trim() ?? '')
					assert(
						JSON.stringify(visibleHeadings) ===
							JSON.stringify(expectedHeadings),
						`Tab ${tabIndex} displayed headings from another tab: ${JSON.stringify(visibleHeadings)}`,
					)
				}
				buttons()[0].click()
				assert(
					buttons()[0].getAttribute('aria-selected') === 'true',
					'Sync tab did not activate',
				)
				const definitions = settingTab.settingItems.flatMap((item) =>
					'type' in item && item.type === 'group' ? (item.items ?? []) : [item],
				)
				assert(
					!definitions.some((item) => 'type' in item && item.type === 'page'),
					'Settings reverted to directory navigation',
				)
				const ai = definitions.find(
					(item) =>
						'aliases' in item &&
						item.aliases?.includes(labels.settings.ai.defaultModel.name),
				)
				assert(ai, 'AI model setting is absent from search metadata')
				host.searchComponent.setValue(labels.settings.ai.defaultModel.name)
				host.onSearchChanged()
				const result = Array.from(
					host.searchResultsEl.querySelectorAll<HTMLElement>(
						'.setting-search-result-item',
					),
				).find((item) => item.textContent === ('name' in ai ? ai.name : ''))
				assert(result, 'Native search did not find the inactive AI tab')
				result.click()
				assert(
					buttons()[1].getAttribute('aria-selected') === 'true',
					'Native search did not activate AI',
				)
				const target = settingTab.getElementForDefinition(ai)
				assert(
					target && target.offsetHeight > 0,
					'Native search target remained hidden',
				)
				assert(target.querySelector('button'), 'AI controls were not rendered')
				host.searchComponent.setValue('')
				host.onSearchChanged()
				assert(
					buttons()[1].getAttribute('aria-selected') === 'true',
					'Clearing search lost the selected tab',
				)
				buttons()[1].dispatchEvent(
					new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
				)
				assert(
					buttons()[2].getAttribute('aria-selected') === 'true',
					'Keyboard tab navigation failed',
				)
				settingTab.update()
				assert(
					buttons()[2].getAttribute('aria-selected') === 'true',
					'Settings refresh lost the selected tab',
				)
				assert(
					!buttons()[0].closest('.setting-items'),
					'Settings refresh moved tabs back inside the card',
				)

				// Simulate mobile CSS at a narrow width; neutral mixed-script labels
				// cover glyph sizing without placing user values in search metadata.
				const bar = container.querySelector<HTMLElement>('.ns-settings-tabs')!
				bar.addClass('is-mobile')
				bar.setCssStyles({ width: '280px' })
				buttons()[0].textContent = '同步 sync 🧭'
				for (const button of buttons()) {
					const style = getComputedStyle(button)
					assert(
						button.offsetHeight >= 44,
						'Mobile tab touch target is too small',
					)
					assert(style.whiteSpace === 'nowrap', 'Mobile tab label can wrap')
					assert(
						style.backgroundColor === 'rgba(0, 0, 0, 0)' ||
							button.classList.contains('is-active'),
						'Mobile inactive tab fell back to a filled native button',
					)
				}
				assert(
					bar.scrollWidth >= bar.clientWidth,
					'Narrow tab strip is not scrollable',
				)
			}
		} finally {
			settingTab.plugin.settings.language = language
			await settingTab.plugin.i18nService.update()
			host.searchComponent.setValue('')
			settingTab.update()
			host.close()
		}
	} else {
		throw new Error('Settings search requires Obsidian 1.13.0')
	}
}

/** Exercise all four combinations and real host registrations without model/network calls. */
export async function hotTogglesFeatureModules(app: App) {
	let plugin = getProductionPlugin(app)
	const original = { ...plugin.localSettings.modules }
	const state = (enabled: boolean) =>
		enabled ? ModuleState.Enabled : ModuleState.Disabled
	const setModules = async (sync: boolean, ai: boolean) => {
		await plugin.settingsService.setModuleState('sync', state(sync))
		await plugin.settingsService.setModuleState('ai', state(ai))
	}
	const commandIds = () =>
		Object.keys(
			(app as unknown as { commands: { commands: Record<string, unknown> } })
				.commands.commands,
		)
	const owns = (id: string) => commandIds().includes(`nutstore-sync:${id}`)
	try {
		for (const [sync, ai] of [
			[false, false],
			[true, false],
			[false, true],
			[true, true],
			[false, false],
			[true, true],
		]) {
			await setModules(sync, ai)
			assert(
				plugin.sync.lifecycle.active === sync,
				'Synchronization lifetime disagrees with its setting',
			)
			assert(
				plugin.ai.lifecycle.active === ai,
				'AI lifetime disagrees with its setting',
			)
			assert(
				owns('start-sync') === sync,
				'Synchronization command survived disabling or failed to return',
			)
			assert(
				owns('open-chatbox') === ai,
				'Chat command survived disabling or failed to return',
			)
			assert(
				owns('open-memory-note') === ai,
				'Memory command disagrees with AI lifetime',
			)
			if (ai) {
				await plugin.ai.openChatbox()
				await plugin.ai.chat.ensureSession()
				plugin.ai.chat.updateInputDraft('Neutral draft / 中性草稿 🌱')
			} else {
				await plugin.ai.openChatbox()
				assert(
					app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 0,
					'Disabled AI opened or retained a ChatBox',
				)
			}
			const local = JSON.parse(
				await app.vault.adapter.read(`${plugin.manifest.dir}/data.local.json`),
			) as { modules: Record<'sync' | 'ai', ModuleState> }
			assert(
				local.modules.sync === state(sync) && local.modules.ai === state(ai),
				'Module enums were not persisted device-locally',
			)
			const synced = ((await plugin.loadData()) ?? {}) as Record<
				string,
				unknown
			>
			assert(
				!('syncModule' in synced) && !('aiModule' in synced),
				'Module enums leaked into synced data.json',
			)
		}
		const host = (
			app as unknown as {
				setting: {
					open(): void
					close(): void
					openTabById(id: string): void
				}
			}
		).setting
		const originalSave = plugin.settingsService.setModuleState
		let pendingSave: Promise<void> | undefined
		plugin.settingsService.setModuleState = function (module, value) {
			pendingSave = originalSave.call(this, module, value)
			return pendingSave
		}
		host.open()
		try {
			host.openTabById('nutstore-sync')
			const labels = plugin.settings.language?.startsWith('zh') ? zh : en
			for (const [key, label] of [
				['sync', labels.settings.modules.sync],
				['ai', labels.settings.modules.ai],
			] as const) {
				for (const enabled of [false, true]) {
					await plugin.settingTab.rerenderIfVisible()
					const row = Array.from(
						plugin.settingTab.containerEl.querySelectorAll('.setting-item'),
					).find(
						(element) =>
							element.querySelector('.setting-item-name')?.textContent ===
							label,
					)
					const input = row?.querySelector<HTMLInputElement>(
						'input[type="checkbox"]',
					)
					assert(input, `Module toggle was not rendered: ${key}`)
					pendingSave = undefined
					input.click()
					assert(pendingSave, `Module toggle did not save: ${key}`)
					await pendingSave
					assert(
						plugin.localSettings.modules[key] === state(enabled),
						`Module toggle did not apply the enum: ${key}`,
					)
				}
			}
		} finally {
			plugin.settingsService.setModuleState = originalSave
			host.close()
		}
		const scope = plugin.ai.lifecycle.scope
		const oldChat = plugin.ai.chat
		const stopping = plugin.settingsService.setModuleState(
			'ai',
			ModuleState.Disabled,
		)
		assert(
			scope.signal.aborted,
			'AI was not revoked before settings persistence completed',
		)
		await Promise.all([
			stopping,
			plugin.settingsService.setModuleState('ai', ModuleState.Enabled),
		])
		assert(
			plugin.ai.chat !== oldChat,
			'Re-enabling reused a retired chat runtime',
		)
		let refused = false
		try {
			await oldChat.sendMessage('Neutral request / 中性请求 🌱')
		} catch {
			refused = true
		}
		assert(refused, 'A retired chat runtime accepted work after re-enabling')
		await setModules(false, false)
		await reloadsProductionPlugin(app)
		plugin = getProductionPlugin(app)
		assert(
			!plugin.sync.lifecycle.active && !plugin.ai.lifecycle.active,
			'Cold loading activated a disabled module',
		)
		assert(
			!owns('start-sync') && !owns('open-chatbox'),
			'Cold loading registered commands for disabled modules',
		)
		await plugin.ai.openChatbox()
		assert(
			app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 0,
			'Cold disabled AI opened a ChatBox',
		)
	} finally {
		await plugin.settingsService.setModuleState('sync', original.sync)
		await plugin.settingsService.setModuleState('ai', original.ai)
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
	}
}

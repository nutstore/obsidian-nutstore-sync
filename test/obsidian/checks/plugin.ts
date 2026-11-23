import { requireApiVersion, type App } from 'obsidian'
import type { ModuleState } from '~/modules/lifecycle'
import type { SyncRunSnapshot } from '~/services/progress.service'
import { assert } from './assert'
import {
	APP_VIEW_TYPE,
	CHATBOX_LOCATION,
	CHATBOX_VIEW_TYPE,
	createNeutralProvider,
	getProductionPlugin,
	MODULE_STATE,
	PLUGIN_ID,
	SESSION_APP_OPEN_MODE,
	SKILLS_ROOT,
} from './constants'
import { assertViewAboveMobileNavigation } from './mobile-navigation'

export interface LifecycleStep {
	name: string
	status: 'started' | 'completed' | 'failed'
	startedAt: string
	elapsedMs: number
}

function createCheckStep(recordStep: (step: LifecycleStep) => Promise<void>) {
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

async function withNeutralProvider(
	plugin: ReturnType<typeof getProductionPlugin>,
	run: () => Promise<void>,
) {
	const originalLocation = plugin.localSettings.ai.chatboxLocation
	const originalProviders = plugin.settings.ai.providers
	const originalDefaultModel = plugin.settings.ai.defaultModel
	const provider = createNeutralProvider(
		'neutral-provider',
		'Neutral provider / 中性服务 🌱',
	)
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

export async function loadsProductionPlugin(app: App) {
	getProductionPlugin(app)
}

export async function opensChatboxInChosenLocationAndSetupFlow(app: App) {
	const plugin = getProductionPlugin(app)
	const originalLocation = plugin.localSettings.ai.chatboxLocation
	const originalProviders = plugin.settings.ai.providers
	const originalDefaultModel = plugin.settings.ai.defaultModel
	const provider = createNeutralProvider(
		'location-provider',
		'Location provider / 位置服务 🌱',
	)

	try {
		// 1. Without any provider configured, setup opens in the editor split then moves to sidebar once configured.
		plugin.localSettings.ai.chatboxLocation = CHATBOX_LOCATION.Sidebar
		plugin.settings.ai.providers = {}
		plugin.settings.ai.defaultModel = undefined
		await plugin.settingsService.saveSettings()
		await plugin.ai.chat.ensureSession()
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)

		await plugin.ai.openChatbox()
		const setupLeaf = app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]
		assert(
			setupLeaf && setupLeaf.getRoot() === app.workspace.rootSplit,
			'Provider setup did not open in the editor split',
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
			configuredLeaves.length === 1 &&
				configuredLeaves[0]?.getRoot() === app.workspace.rightSplit,
			'Completing provider setup did not move Chatbox to the chosen sidebar without duplication',
		)

		// 2. Switching locations preserves session and Unicode draft without duplicating leaves.
		const draft = 'Neutral draft / 中性草稿 🌱'
		const sessionId = plugin.ai.chat.getViewProps().activeSessionId
		plugin.ai.chat.updateInputDraft(draft)
		for (const location of [
			CHATBOX_LOCATION.Sidebar,
			CHATBOX_LOCATION.Editor,
			CHATBOX_LOCATION.Sidebar,
		]) {
			plugin.localSettings.ai.chatboxLocation = location
			await plugin.ai.openChatbox()
			const leaves = app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)
			assert(leaves.length === 1, 'Changing location duplicated the Chatbox')
			const leaf = leaves[0]!
			assert(
				leaf.getRoot() ===
					(location === CHATBOX_LOCATION.Editor
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
				props.activeSessionId === sessionId && props.draft.text === draft,
				'Moving Chatbox lost its session or Unicode draft',
			)
		}
	} finally {
		plugin.localSettings.ai.chatboxLocation = originalLocation
		plugin.settings.ai.providers = originalProviders
		plugin.settings.ai.defaultModel = originalDefaultModel
		await plugin.settingsService.saveSettings()
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
	}
}

export async function keepsChatboxMobileLayoutAndWorkspacePickerStable(
	app: App,
) {
	const plugin = getProductionPlugin(app)
	await withNeutralProvider(plugin, async () => {
		plugin.ai.chat.updateInputDraft('Neutral message / 中性消息 🌱')
		for (const location of [
			CHATBOX_LOCATION.Editor,
			CHATBOX_LOCATION.Sidebar,
		]) {
			plugin.localSettings.ai.chatboxLocation = location
			await plugin.ai.openChatbox()
			const view = app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]!.view
			try {
				await assertViewAboveMobileNavigation(view, '.ns-composer-send')
				if (location === CHATBOX_LOCATION.Sidebar) {
					const picker = view.containerEl.querySelector<HTMLButtonElement>(
						'.ns-workspace-picker',
					)
					assert(picker, 'Workspace picker is unavailable')
					picker.dispatchEvent(
						new PointerEvent('pointerdown', { bubbles: true, composed: true }),
					)
					await new Promise((resolve) => window.setTimeout(resolve, 50))
					assert(
						picker.isConnected &&
							view.containerEl.querySelector('.ns-workspace-picker') === picker,
						'Workspace picker was rebuilt by pointer down',
					)
				}
			} finally {
				app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
			}
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
	await withNeutralProvider(plugin, async () => {
		await plugin.ai.chat.selectWorkspace(id)
		const sessionId = plugin.ai.chat.workspaceState.sessionId!
		const originalOpen = plugin.ai.openApp
		let pending: Promise<unknown>[] = []
		plugin.ai.openApp = (appId) => {
			const opened = originalOpen.call(plugin.ai, appId)
			pending.push(opened)
			return opened
		}
		try {
			for (const location of [
				CHATBOX_LOCATION.Sidebar,
				CHATBOX_LOCATION.Editor,
			]) {
				plugin.localSettings.ai.chatboxLocation = location
				for (const mode of [
					SESSION_APP_OPEN_MODE.Manual,
					SESSION_APP_OPEN_MODE.Automatic,
				]) {
					app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
					app.workspace.detachLeavesOfType(APP_VIEW_TYPE)
					plugin.localSettings.ai.sessionAppOpenMode = mode
					pending = []
					// Open the real production ChatBox view so its own ChatWorkspacePanel runs.
					await plugin.ai.openChatbox()
					await new Promise((resolve) => window.setTimeout(resolve, 80))
					await Promise.all(pending)
					assert(
						pending.length ===
							(mode === SESSION_APP_OPEN_MODE.Automatic ? 1 : 0),
						`Session App opening (${mode}) ignored the independent device preference`,
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
				}
			}
		} finally {
			app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
			app.workspace.detachLeavesOfType(APP_VIEW_TYPE)
			plugin.ai.openApp = originalOpen
			plugin.localSettings.ai.sessionAppOpenMode = originalMode
			plugin.localSettings.ai.chatboxLocation = originalLocation
			await plugin.ai.chat.selectWorkspace(undefined)
			await plugin.ai.workspaces.remove(id)
		}
	})
}

export async function rendersSearchableSettingsAndVaultSkills(
	app: App,
	recordStep: (step: LifecycleStep) => Promise<void>,
) {
	if (!requireApiVersion('1.13.0')) {
		throw new Error('Settings search requires Obsidian 1.13.0')
	}
	const step = createCheckStep(recordStep)
	const plugin = getProductionPlugin(app)
	const { settingTab } = plugin
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
	const adapter = app.vault.adapter
	const language = plugin.settings.language
	const originalDisabled = [...plugin.settings.ai.disabledSkills]
	const skillDir = `${SKILLS_ROOT}/settings-probe-skill`

	await step('Settings: prepare Vault skill fixture', async () => {
		if (!(await adapter.exists(SKILLS_ROOT))) await adapter.mkdir(SKILLS_ROOT)
		await adapter.mkdir(skillDir)
		await adapter.write(
			`${skillDir}/SKILL.md`,
			'---\nname: settings-probe-skill\ndescription: Neutral Skill / 中性技能 🌱\n---\n',
		)
	})

	const originalSave = plugin.settingsService.saveSettings
	let pendingSave: Promise<void> | undefined
	try {
		plugin.settings.ai.disabledSkills = originalDisabled.filter(
			(name) => name !== 'settings-probe-skill',
		)
		plugin.settingsService.saveSettings = function () {
			pendingSave = originalSave.call(this)
			return pendingSave
		}
		host.open()

		for (const locale of ['en', 'zh'] as const) {
			plugin.settings.language = locale
			await plugin.i18nService.update()
			settingTab.update()
			host.openTabById(PLUGIN_ID)
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

			const tabHeadings: string[][] = []
			for (let tabIndex = 0; tabIndex < 3; tabIndex += 1) {
				buttons()[tabIndex].click()
				const visible = Array.from(
					container.querySelectorAll<HTMLElement>(
						'.setting-item.setting-item-heading',
					),
				)
					.filter((heading) => heading.offsetHeight > 0)
					.map((heading) => heading.textContent?.trim() ?? '')
				assert(
					visible.length > 0,
					`Tab ${tabIndex} rendered no visible headings in ${locale}`,
				)
				tabHeadings.push(visible)
			}
			const allHeadings = tabHeadings.flat()
			assert(
				new Set(allHeadings).size === allHeadings.length,
				`Tabs shared or duplicated headings in ${locale}: ${JSON.stringify(tabHeadings)}`,
			)

			// Native Obsidian search navigates into an inactive tab and makes its controls visible.
			buttons()[0].click()
			const definitions = settingTab.settingItems.flatMap((item) =>
				'type' in item && item.type === 'group' ? (item.items ?? []) : [item],
			)
			const aiTarget = definitions.find(
				(item) =>
					'aliases' in item &&
					Array.isArray(item.aliases) &&
					item.aliases.length > 0 &&
					'name' in item &&
					typeof item.name === 'string' &&
					tabHeadings[1].includes(item.name),
			)
			const searchTerm =
				aiTarget && 'aliases' in aiTarget && aiTarget.aliases?.[0]
					? aiTarget.aliases[0]
					: tabHeadings[1][0]
			host.searchComponent.setValue(searchTerm)
			host.onSearchChanged()
			const result = Array.from(
				host.searchResultsEl.querySelectorAll<HTMLElement>(
					'.setting-search-result-item',
				),
			).find((item) =>
				item.textContent?.includes(
					aiTarget && 'name' in aiTarget ? String(aiTarget.name) : searchTerm,
				),
			)
			assert(
				result,
				`Native search did not find inactive AI setting (${searchTerm}) in ${locale}`,
			)
			result.click()
			assert(
				buttons()[1].getAttribute('aria-selected') === 'true',
				'Native search did not activate AI tab',
			)

			host.searchComponent.setValue('')
			host.onSearchChanged()
			buttons()[1].dispatchEvent(
				new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
			)
			assert(
				buttons()[2].getAttribute('aria-selected') === 'true',
				'Keyboard tab navigation failed',
			)

			// Verify mobile tab touch targets and single-line nowrap CSS.
			const bar = container.querySelector<HTMLElement>('.ns-settings-tabs')!
			bar.addClass('is-mobile')
			bar.setCssStyles({ width: '280px' })
			for (const button of buttons()) {
				const style = getComputedStyle(button)
				assert(
					button.offsetHeight >= 44,
					'Mobile tab touch target is too small',
				)
				assert(style.whiteSpace === 'nowrap', 'Mobile tab label can wrap')
			}
			bar.removeClass('is-mobile')
			bar.removeAttribute('style')
		}

		// Verify Vault Skills settings section renders UTF-8 metadata and persists toggle changes.
		const section = settingTab.skillSettings
		section.containerEl.show()
		await step('Skills: render catalog', () => section.display())
		const text = section.containerEl.textContent ?? ''
		assert(
			text.includes('settings-probe-skill') &&
				text.includes('Neutral Skill / 中性技能 🌱'),
			'Skills settings did not render the Vault Skill and UTF-8 description',
		)
		for (const enabled of [false, true]) {
			const row = Array.from(
				section.containerEl.querySelectorAll('.setting-item'),
			).find(
				(element) =>
					element.querySelector('.setting-item-name')?.textContent ===
					'settings-probe-skill',
			)
			const input = row?.querySelector<HTMLInputElement>(
				'.checkbox-container input[type="checkbox"]',
			)
			assert(input, 'Skill toggle input was not rendered')
			pendingSave = undefined
			input.click()
			assert(pendingSave, 'Toggling a Skill did not save settings')
			await pendingSave
			const stored = (await plugin.loadData()) as {
				ai: { disabledSkills: string[] }
			}
			assert(
				stored.ai.disabledSkills.includes('settings-probe-skill') === !enabled,
				'Skill activation was not persisted',
			)
			await section.display()
		}
	} finally {
		host.searchComponent.setValue('')
		host.close()
		plugin.settingsService.saveSettings = originalSave
		plugin.settings.language = language
		plugin.settings.ai.disabledSkills = originalDisabled
		await plugin.i18nService.update()
		await originalSave.call(plugin.settingsService)
		await adapter.remove(`${skillDir}/SKILL.md`)
		await adapter.rmdir(skillDir, true)
	}
}

/** Exercise the loaded production SyncProgressModal and its production ScanIssuesModal handoff. */
export async function rendersSyncProgressAndScanIssues(app: App) {
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
		const stopButton = modal.querySelector(
			'.nutstore-sync-progress__footer button',
		)
		assert(
			stopButton instanceof HTMLButtonElement &&
				window.getComputedStyle(stopButton).display === 'none',
			'Sync progress modal kept its stop control after completion',
		)

		const path = 'Notes 笔记🌱/Section & <draft>📘'
		for (const locale of ['zh', 'en'] as const) {
			plugin.settings.language = locale
			await plugin.i18nService.update()
			progress.run = {
				...syncing,
				status: 'partialScan',
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
				'Production progress did not warn about partial scan',
			)
			const summary = modal.querySelector(
				'.nutstore-sync-progress__scan-issues',
			)
			const viewButton = summary?.querySelector('button')
			assert(
				summary instanceof HTMLElement &&
					summary.textContent?.includes('1') &&
					viewButton instanceof HTMLButtonElement,
				'Production progress lost scan issues summary or button',
			)

			// Click the production button to open the production ScanIssuesModal.
			viewButton.click()
			const issuesModal =
				document.querySelector<HTMLElement>('.scan-issues-modal')
			assert(issuesModal, 'Progress dialog button did not open ScanIssuesModal')
			assert(
				issuesModal.textContent?.includes(path) &&
					!issuesModal.querySelector('draft'),
				'ScanIssuesModal lost Unicode path or parsed it as HTML',
			)
			;[...issuesModal.querySelectorAll('button')].at(-1)?.click()
			assert(
				!document.querySelector('.scan-issues-modal'),
				'ScanIssuesModal did not close cleanly',
			)
		}

		// Reopening after close retains finished run state.
		progress.closeProgressModal()
		assert(
			!document.querySelector('.modal.nutstore-sync-progress-modal'),
			'Sync progress modal did not close',
		)
		progress.showProgressModal()
		assert(
			document.querySelector('.modal.nutstore-sync-progress-modal'),
			'Reopened sync progress did not mount',
		)
	} finally {
		plugin.settings.language = language
		await plugin.i18nService.update()
		progress.closeProgressModal()
		progress.run = previousRun
	}
}

/** Exercise all four Sync x AI module combinations, real command registrations, and cold reload. */
export async function hotTogglesFeatureModules(app: App) {
	let plugin = getProductionPlugin(app)
	const original = { ...plugin.localSettings.modules }
	const state = (enabled: boolean) =>
		enabled ? MODULE_STATE.Enabled : MODULE_STATE.Disabled
	const setModules = async (sync: boolean, ai: boolean) => {
		await plugin.settingsService.setModuleState('sync', state(sync))
		await plugin.settingsService.setModuleState('ai', state(ai))
	}
	const commandIds = () =>
		Object.keys(
			(app as unknown as { commands: { commands: Record<string, unknown> } })
				.commands.commands,
		)
	const owns = (id: string) => commandIds().includes(`${PLUGIN_ID}:${id}`)

	try {
		for (const [sync, ai] of [
			[false, false],
			[true, false],
			[false, true],
			[true, true],
		]) {
			await setModules(sync, ai)
			assert(
				plugin.sync.lifecycle.active === sync &&
					plugin.ai.lifecycle.active === ai,
				'Module lifetimes disagree with settings',
			)
			assert(
				owns('start-sync') === sync &&
					owns('open-chatbox') === ai &&
					owns('open-memory-note') === ai,
				'Registered Obsidian commands disagree with active modules',
			)
			if (!ai) {
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
				'Module states were not persisted device-locally',
			)
			const synced = ((await plugin.loadData()) ?? {}) as Record<
				string,
				unknown
			>
			assert(
				!('syncModule' in synced) && !('aiModule' in synced),
				'Module states leaked into synced data.json',
			)
		}

		// Revoking AI immediately aborts its scope and retires the old chat runtime.
		const scope = plugin.ai.lifecycle.scope
		const oldChat = plugin.ai.chat
		const stopping = plugin.settingsService.setModuleState(
			'ai',
			MODULE_STATE.Disabled,
		)
		assert(
			scope.signal.aborted,
			'AI scope was not aborted before persistence finished',
		)
		await Promise.all([
			stopping,
			plugin.settingsService.setModuleState('ai', MODULE_STATE.Enabled),
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

		// Cold reload with both modules disabled keeps them inactive.
		await setModules(false, false)
		const plugins = (
			app as unknown as {
				plugins: {
					disablePlugin(id: string): Promise<void>
					enablePlugin(id: string): Promise<void>
				}
			}
		).plugins
		await plugins.disablePlugin(PLUGIN_ID)
		await plugins.enablePlugin(PLUGIN_ID)
		plugin = getProductionPlugin(app)
		assert(
			!plugin.sync.lifecycle.active &&
				!plugin.ai.lifecycle.active &&
				!owns('start-sync') &&
				!owns('open-chatbox'),
			'Cold reload activated disabled modules or registered their commands',
		)
	} finally {
		await plugin.settingsService.setModuleState('sync', original.sync)
		await plugin.settingsService.setModuleState('ai', original.ai)
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
	}
}

export async function reloadsAndDetachesProductionPlugin(
	app: App,
	recordStep: (step: LifecycleStep) => Promise<void>,
) {
	const step = createCheckStep(recordStep)
	const plugins = (
		app as unknown as {
			plugins: {
				disablePlugin(id: string): Promise<void>
				enablePlugin(id: string): Promise<void>
				disablePluginAndSave(id: string): Promise<void>
				enablePluginAndSave(id: string): Promise<boolean>
			}
		}
	).plugins

	await step('reload: disable + enable', async () => {
		await plugins.disablePlugin(PLUGIN_ID)
		await plugins.enablePlugin(PLUGIN_ID)
		getProductionPlugin(app)
	})

	const plugin = getProductionPlugin(app)
	await step('openChatbox: initial', () => plugin.ai.openChatbox())
	assert(
		app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 1,
		'ChatBox did not open before plugin disable',
	)

	await step('disablePluginAndSave', () =>
		plugins.disablePluginAndSave(PLUGIN_ID),
	)
	try {
		assert(
			app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 0,
			'ChatBox remained attached after plugin disable',
		)
	} finally {
		await step('enablePluginAndSave', async () => {
			assert(
				await plugins.enablePluginAndSave(PLUGIN_ID),
				'Production plugin failed to re-enable',
			)
		})
	}

	const reloaded = getProductionPlugin(app)
	try {
		await step('openChatbox: reloaded', () => reloaded.ai.openChatbox())
		assert(
			app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE).length === 1,
			'Production plugin created duplicate ChatBox views after re-enable',
		)
	} finally {
		app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
	}
}

import { requireApiVersion, type App } from 'obsidian'
import type { NutstoreSettingTab } from '~/settings'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'
import { CHATBOX_VIEW_TYPE } from '~/views/chatbox.view'
import { assert } from './assert'

interface ProductionPlugin {
	settingTab: NutstoreSettingTab
	isSyncing: boolean
	commandService: {
		openChatbox(): Promise<void>
	}
	progressService: {
		syncProgress: { total: number; completed: unknown[]; current: unknown }
		preparationProgress: unknown
		syncEnd: boolean
		syncFailed: boolean
		syncFailedCount: number
		showProgressModal(): void
		closeProgressModal(): void
		updateModal: (() => void) & { flush?: () => void }
	}
}

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

export async function detachesChatboxWhenProductionPluginIsDisabled(
	app: App,
	recordStep: (step: LifecycleStep) => Promise<void>,
) {
	// Persist before invoking each operation so even a blocked renderer leaves
	// the exact pending call in the guest diagnostics.
	const step = async (name: string, operation: () => void | Promise<void>) => {
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
	const plugins = (
		app as unknown as {
			plugins: {
				disablePluginAndSave(id: string): Promise<void>
				enablePluginAndSave(id: string): Promise<boolean>
			}
		}
	).plugins
	const plugin = getProductionPlugin(app)
	await step('openChatbox: initial', () => plugin.commandService.openChatbox())
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
		await step('openChatbox: reloaded', () =>
			reloadedPlugin.commandService.openChatbox(),
		)
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
	const progress = plugin.progressService
	plugin.isSyncing = true
	progress.syncProgress = { total: 0, completed: [], current: null }
	progress.preparationProgress = null
	progress.syncEnd = false
	progress.syncFailed = false
	progress.syncFailedCount = 0

	try {
		progress.showProgressModal()
		const modal = document.querySelector('.modal.nutstore-sync-progress-modal')
		assert(modal, 'Sync progress modal did not open')
		assert(
			modal.querySelector('.nutstore-sync-progress__status-icon--syncing'),
			'Sync progress modal did not render syncing state',
		)

		progress.syncEnd = true
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
			stopButton?.classList.contains('hidden'),
			`Sync progress modal kept its stop control after completion: ${stopButton?.className ?? 'missing'}`,
		)
	} finally {
		progress.closeProgressModal()
		plugin.isSyncing = false
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
				buttons()[0].click()
				assert(
					buttons()[0].getAttribute('aria-selected') === 'true',
					'Sync tab did not activate',
				)
				const definitions = settingTab.settingItems
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

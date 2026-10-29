import { Modal, Notice, SearchComponent, Setting, setIcon } from 'obsidian'
import type NutstorePlugin from '~/index'
import type { SavedApp } from '~/ai/apps/store'
import { appError } from '~/ai/apps/error'
import i18n from '~/i18n'
import { isFuzzySubsequenceMatch } from '~/utils/fuzzy-match'

/** Installed Apps share the same source and deletion lifecycle as the composer. */
export default class AppManagerModal extends Modal {
	private items: Array<{ id: string; app?: SavedApp }> = []
	private query = ''
	private epoch = 0
	private unsubscribe?: () => void
	private listEl?: HTMLElement

	constructor(private readonly plugin: NutstorePlugin) {
		super(plugin.app)
		this.setTitle(i18n.t('apps.manageApps'))
		this.modalEl.addClass('ns-app-manager-modal')
	}

	onOpen() {
		new SearchComponent(this.contentEl)
			.setPlaceholder(i18n.t('apps.searchApps'))
			.onChange((value) => {
				this.query = value
				this.render()
			})
		this.listEl = this.contentEl.createDiv({ attr: { 'aria-live': 'polite' } })
		this.unsubscribe = this.plugin.ai.apps.subscribe(() => void this.refresh())
		void this.refresh()
	}

	private async refresh() {
		const epoch = ++this.epoch
		try {
			const items = await this.plugin.ai.apps.list()
			if (epoch !== this.epoch) return
			this.items = items
			this.render()
		} catch (error) {
			if (epoch === this.epoch) new Notice(appError(error))
		}
	}

	private render() {
		const list = this.listEl
		if (!list) return
		list.empty()
		const query = this.query.trim()
		const items = this.items.filter(({ id, app }) =>
			isFuzzySubsequenceMatch(query, app?.manifest.title ?? id),
		)
		if (!items.length) {
			list.createEl('p', {
				text: i18n.t(query ? 'apps.noSearchResults' : 'apps.noInstalledApps'),
			})
		}
		for (const { id, app } of items) {
			const row = new Setting(list)
				.setName(app?.manifest.title ?? id)
				.setClass('ns-app-manager-row')
			row.nameEl.setAttribute('title', app?.manifest.title ?? id)
			setIcon(
				row.settingEl.createSpan({ cls: 'ns-app-manager-icon' }),
				this.plugin.ai.appIcon(id, app?.manifest.iconSvg),
			)
			row.addButton((button) =>
				button
					.setButtonText(i18n.t('apps.open'))
					.setDisabled(!app)
					.onClick(async () => {
						button.setDisabled(true)
						try {
							await this.plugin.ai.openApp(id)
							this.close()
						} catch (error) {
							new Notice(appError(error))
							button.setDisabled(false)
						}
					}),
			)
			row.addButton((button) =>
				button
					.setButtonText(i18n.t('apps.delete'))
					.setClass('mod-warning')
					.onClick(() => this.confirmDelete(id, app?.manifest.title ?? id)),
			)
		}
	}

	private confirmDelete(id: string, title: string) {
		const modal = this.plugin.ai.lifecycle.scope.ownModal(new Modal(this.app))
		modal.setTitle(`${i18n.t('apps.deleteApp')} · ${title}`)
		modal.contentEl.createEl('p', {
			text: i18n.t('apps.deleteAppPrompt', { name: title }),
		})
		new Setting(modal.contentEl)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('apps.cancel'))
					.onClick(() => modal.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('apps.delete'))
					.setClass('mod-warning')
					.onClick(async () => {
						button.setDisabled(true)
						try {
							await this.plugin.ai.apps.remove(id)
							modal.close()
							await this.refresh()
						} catch (error) {
							new Notice(appError(error))
							button.setDisabled(false)
						}
					}),
			)
		modal.open()
	}

	onClose() {
		this.epoch++
		this.unsubscribe?.()
		this.listEl = undefined
		this.contentEl.empty()
	}
}

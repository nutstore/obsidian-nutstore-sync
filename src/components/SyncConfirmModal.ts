import { App, ButtonComponent, Modal, setIcon } from 'obsidian'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import i18n from '../i18n'
import {
	getConflictStrategyI18nKey,
	getSyncPolicyI18nKey,
	getSyncPolicyNameI18nKey,
	SyncPolicy,
	type NutstoreLocalSettings,
	type NutstoreSettings,
	type SyncSelection,
} from '../settings'
import { renderSyncPolicyRules } from './sync-policy-rules'

export default class SyncConfirmModal extends Modal {
	// Modal.open() owns `selection` for restoring the editor's text selection.
	#syncSelection: SyncSelection
	private readonly optionGroup = crypto.randomUUID()

	constructor(
		app: App,
		private settings: NutstoreSettings,
		localSettings: NutstoreLocalSettings,
		private onConfirm: (selection: SyncSelection) => void,
	) {
		super(app)
		this.#syncSelection = {
			syncPolicy: localSettings.syncPolicy,
			conflictStrategy: settings.conflictStrategy,
		}
	}

	onOpen() {
		this.setTitle(i18n.t('sync.confirmModal.title'))
		const { contentEl } = this
		addClassTokens(this.modalEl, ':uno: sync-confirm-modal')
		addClassTokens(contentEl, ':uno: sync-confirm-modal__content')
		const body = contentEl.createDiv({ cls: 'sync-confirm-modal__body' })
		body.createEl('p', {
			cls: 'sync-confirm-modal__remote',
			text: i18n.t('sync.confirmModal.remoteDir', {
				dir: this.settings.remoteDir,
			}),
		})
		const options = body.createDiv({ cls: 'sync-confirm-modal__options' })
		const controls = options.createDiv({ cls: 'sync-confirm-modal__controls' })
		const policies = controls.createEl('fieldset', {
			cls: 'sync-confirm-modal__policies',
		})
		policies.createEl('legend', {
			text: i18n.t('sync.confirmModal.policyTitle'),
		})
		const conflicts = controls.createEl('fieldset', {
			cls: 'sync-confirm-modal__conflicts',
		})
		conflicts.createEl('legend', {
			text: i18n.t('sync.confirmModal.conflictTitle'),
		})

		for (const policy of Object.values(SyncPolicy)) {
			const radio = this.createOption(
				policies,
				'policy',
				policy,
				i18n.t(getSyncPolicyNameI18nKey(policy)),
				policy === this.#syncSelection.syncPolicy,
			)
			radio.addEventListener('change', () => {
				if (!radio.checked) return
				this.#syncSelection.syncPolicy = policy
				update()
			})
		}
		for (const strategy of Object.values(ConflictStrategy)) {
			const radio = this.createOption(
				conflicts,
				'conflict',
				strategy,
				i18n.t(
					`settings.conflictStrategy.${getConflictStrategyI18nKey(strategy)}`,
				),
				strategy === this.#syncSelection.conflictStrategy,
			)
			radio.addEventListener('change', () => {
				if (!radio.checked) return
				this.#syncSelection.conflictStrategy = strategy
				update()
			})
		}
		const conflictNote = conflicts.createEl('p', {
			cls: 'sync-confirm-modal__hint',
			attr: { 'aria-live': 'polite' },
		})
		const rules = options.createEl('section', {
			cls: 'sync-confirm-modal__rules',
			attr: { 'aria-live': 'polite' },
		})
		rules.createEl('h3', {
			cls: 'sync-confirm-modal__rules-title',
			text: i18n.t('sync.confirmModal.rulesTitle'),
		})
		const ruleContent = rules.createDiv({
			cls: 'sync-confirm-modal__rule-scroll',
		})
		const basis = body.createDiv({ cls: 'sync-confirm-modal__basis' })
		const comparison = basis.createEl('p')
		comparison.createEl('strong', {
			text: i18n.t('sync.confirmModal.basisTitle'),
		})
		comparison.createSpan({ text: i18n.t('sync.confirmModal.policyBasis') })
		basis.createEl('p', {
			text: i18n.t('sync.confirmModal.policyRecordNote'),
		})
		const notice = body.createDiv({ cls: 'sync-confirm-modal__notice' })
		const noticeIcon = notice.createSpan({ attr: { 'aria-hidden': 'true' } })
		setIcon(noticeIcon, 'triangle-alert')
		notice.createEl('p', { text: i18n.t('sync.confirmModal.message') })

		const footer = contentEl.createDiv({ cls: 'sync-confirm-modal__footer' })
		footer.createSpan({
			cls: 'sync-confirm-modal__scope',
			text: i18n.t('sync.confirmModal.scope'),
		})
		const actions = footer.createDiv({ cls: 'sync-confirm-modal__actions' })
		new ButtonComponent(actions)
			.setButtonText(i18n.t('sync.confirmModal.cancel'))
			.onClick(() => this.close())
		const confirm = new ButtonComponent(actions).setCta().onClick(() => {
			this.close()
			this.onConfirm({ ...this.#syncSelection })
		})
		const update = () => {
			const { syncPolicy, conflictStrategy } = this.#syncSelection
			const isTwoWay = syncPolicy === SyncPolicy.TwoWay
			// Reserve the same space so directions, rules and actions never move.
			conflicts.classList.toggle(
				'sync-confirm-modal__conflicts--inactive',
				!isTwoWay,
			)
			conflicts.setAttribute('aria-hidden', String(!isTwoWay))
			conflicts.disabled = !isTwoWay
			conflictNote.setText(
				i18n.t(
					conflictStrategy === ConflictStrategy.NoConflictMerge ||
						conflictStrategy === ConflictStrategy.Diff3
						? 'sync.confirmModal.mergeFilesOnly'
						: 'sync.confirmModal.priorityFilesOnly',
				),
			)
			renderSyncPolicyRules(ruleContent, syncPolicy, conflictStrategy)
			ruleContent.scrollTop = 0
			confirm.setButtonText(
				i18n.t(`sync.confirmModal.actions.${getSyncPolicyI18nKey(syncPolicy)}`),
			)
		}
		update()
	}

	private createOption(
		container: HTMLFieldSetElement,
		group: 'policy' | 'conflict',
		value: SyncPolicy | ConflictStrategy,
		text: string,
		checked: boolean,
	) {
		const label = container.createEl('label', {
			cls: 'sync-confirm-modal__choice',
		})
		const radio = label.createEl('input', {
			type: 'radio',
			value,
			attr: { name: `${this.optionGroup}-${group}` },
		})
		radio.checked = checked
		label.createSpan({ text })
		return radio
	}

	onClose() {
		this.contentEl.empty()
		removeClassTokens(this.contentEl, ':uno: sync-confirm-modal__content')
		removeClassTokens(this.modalEl, ':uno: sync-confirm-modal')
	}
}

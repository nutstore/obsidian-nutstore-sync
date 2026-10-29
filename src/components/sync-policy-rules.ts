import createId from '~/utils/create-id'
import i18n from '~/i18n'
import {
	getConflictStrategyI18nKey,
	getSyncPolicyI18nKey,
	type SyncPolicy,
} from '~/settings'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'

/** Settings and per-run confirmation share the same localized rule definitions. */
export function renderSyncPolicyRules(
	container: HTMLElement,
	policy: SyncPolicy,
	conflictStrategy?: ConflictStrategy,
) {
	container.empty()
	const definitions = i18n.t('settings.syncPolicy.rules', {
		returnObjects: true,
		strategy:
			conflictStrategy === undefined
				? i18n.t('sync.confirmModal.configuredStrategy')
				: i18n.t(
						`settings.conflictStrategy.${getConflictStrategyI18nKey(conflictStrategy)}`,
					),
	})
	const rules = definitions[getSyncPolicyI18nKey(policy)]
	const table = container.createEl('table', {
		cls: 'nutstore-sync-policy-rules',
	})
	const caption = table.createEl('caption', {
		text: i18n.t('settings.syncPolicy.name'),
		attr: { hidden: '' },
	})
	caption.id = createId('accessible-label')
	table.setAttribute('aria-labelledby', caption.id)
	const heading = table.createEl('thead').createEl('tr')
	heading.createEl('th', {
		text: i18n.t('sync.confirmModal.condition'),
		attr: { scope: 'col' },
	})
	heading.createEl('th', {
		text: i18n.t('sync.confirmModal.result'),
		attr: { scope: 'col' },
	})
	const body = table.createEl('tbody')
	for (const rule of rules.rows) {
		const row = body.createEl('tr')
		if (
			'conflict' in rule &&
			rule.conflict &&
			(conflictStrategy === ConflictStrategy.LocalPriority ||
				conflictStrategy === ConflictStrategy.ServerPriority)
		) {
			row.addClass('nutstore-sync-policy-rules__overwrite')
		}
		row.createEl('td', { text: rule.condition })
		row.createEl('td', { text: rule.result })
	}
	if (rules.note) {
		container.createEl('p', {
			cls: 'nutstore-sync-policy-rules__note',
			text: rules.note,
		})
	}
}

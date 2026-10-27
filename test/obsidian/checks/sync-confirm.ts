import type { App } from 'obsidian'
import SyncConfirmModal from '~/components/SyncConfirmModal'
import i18n from '~/i18n'
import {
	DEFAULT_LOCAL_SETTINGS,
	DEFAULT_SETTINGS,
	getConflictStrategyI18nKey,
	getSyncPolicyI18nKey,
	SyncPolicy,
	type SyncSelection,
} from '~/settings'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { assert } from './assert'

/** Exercise native radios, modal sizing and the per-run boundary without syncing. */
export async function rendersSyncConfirmation(app: App) {
	const originalLanguage = i18n.language
	try {
		for (const language of ['en', 'zh']) {
			await i18n.changeLanguage(language)
			const settings = {
				...DEFAULT_SETTINGS,
				remoteDir: '/Notes 笔记🌱/<draft> & examples/',
			}
			const localSettings = { ...DEFAULT_LOCAL_SETTINGS }
			const before = JSON.stringify({ settings, localSettings })
			const confirmed: SyncSelection[] = []
			const mount = () => {
				const modal = new SyncConfirmModal(
					app,
					settings,
					localSettings,
					(value) => {
						confirmed.push(value)
					},
				)
				modal.open()
				return modal
			}
			const modal = mount()
			try {
				const find = (selector: string) => {
					const element = modal.contentEl.querySelector<HTMLElement>(selector)
					assert(element, `Missing confirmation element: ${selector}`)
					return element
				}
				const choose = (value: SyncPolicy | ConflictStrategy) => {
					const input = modal.contentEl.querySelector<HTMLInputElement>(
						`input[value="${value}"]`,
					)
					assert(input, `Missing option: ${value}`)
					input.parentElement!.click()
					assert(input.checked, `Row did not select ${value}`)
				}
				assert(
					modal.contentEl.querySelectorAll('input').length === 9,
					'Options were hidden',
				)
				assert(
					find('.sync-confirm-modal__remote').textContent?.includes(
						settings.remoteDir,
					),
					'Unicode path changed',
				)
				assert(
					find('.sync-confirm-modal__remote').children.length === 0,
					'Path became markup',
				)
				const conflictOptions = find(
					'.sync-confirm-modal__conflicts',
				) as HTMLFieldSetElement
				assert(
					modal.contentEl.querySelector<HTMLInputElement>(
						'fieldset input:checked',
					)?.value === localSettings.syncPolicy,
					'Opening the native modal did not select the saved sync policy',
				)
				assert(
					conflictOptions.querySelector<HTMLInputElement>('input:checked')
						?.value === settings.conflictStrategy,
					'Opening the native modal did not select the saved conflict strategy',
				)
				const confirm = find('.sync-confirm-modal__actions .mod-cta')
				const geometry = () => ({
					dialog: modal.modalEl.getBoundingClientRect(),
					policies: find(
						'.sync-confirm-modal__policies',
					).getBoundingClientRect(),
					rules: find('.sync-confirm-modal__rules').getBoundingClientRect(),
					footer: find('.sync-confirm-modal__footer').getBoundingClientRect(),
					confirm: confirm.getBoundingClientRect(),
				})
				const assertStable = (
					reference: ReturnType<typeof geometry>,
					parts: (keyof ReturnType<typeof geometry>)[] = [
						'dialog',
						'policies',
						'rules',
						'footer',
						'confirm',
					],
				) => {
					const current = geometry()
					for (const part of parts) {
						for (const dimension of ['x', 'y', 'width', 'height'] as const) {
							assert(
								Math.abs(
									current[part][dimension] - reference[part][dimension],
								) < 1,
								`Policy change moved or resized ${part}.${dimension}`,
							)
						}
					}
				}
				const desktopGeometry = geometry()
				for (const strategy of Object.values(ConflictStrategy)) {
					choose(SyncPolicy.TwoWay)
					choose(strategy)
					assert(
						find('tbody').textContent?.includes(
							i18n.t(
								`settings.conflictStrategy.${getConflictStrategyI18nKey(strategy)}`,
							),
						),
						'Conflict result did not update',
					)
					assertStable(desktopGeometry)
				}
				for (const [policy, rowCount] of [
					[SyncPolicy.TwoWay, 5],
					[SyncPolicy.SendOnly, 6],
					[SyncPolicy.SendOnlyOverrideChanges, 3],
					[SyncPolicy.ReceiveOnly, 6],
					[SyncPolicy.ReceiveOnlyRevertLocalChanges, 3],
				] as const) {
					choose(policy)
					assert(
						conflictOptions.disabled === (policy !== SyncPolicy.TwoWay),
						'Conflict controls have wrong applicability',
					)
					assert(
						getComputedStyle(conflictOptions).visibility ===
							(policy === SyncPolicy.TwoWay ? 'visible' : 'hidden'),
						'One-way sync kept the conflict choices visible',
					)
					const rules = find(
						'.sync-confirm-modal__rules',
					).getBoundingClientRect()
					const policies = find(
						'.sync-confirm-modal__policies',
					).getBoundingClientRect()
					assert(
						rules.left >= policies.right &&
							Math.abs(rules.top - policies.top) < 1,
						'Rules did not stay in the right column',
					)
					assertStable(desktopGeometry)
					assert(
						modal.contentEl.querySelectorAll('tbody tr').length === rowCount,
						'Policy rules did not update',
					)
					assert(
						confirm.textContent ===
							i18n.t(
								`sync.confirmModal.actions.${getSyncPolicyI18nKey(policy)}`,
							),
						'Confirmation action did not update',
					)
				}
				choose(SyncPolicy.TwoWay)
				assert(
					modal.contentEl.querySelector<HTMLInputElement>(
						'input[value="server-priority"]',
					)!.checked,
					'Returning to two-way lost conflict selection',
				)
				modal.modalEl.setCssStyles({ width: '320px', height: '420px' })
				await new Promise<void>((resolve) =>
					window.requestAnimationFrame(() =>
						window.requestAnimationFrame(() => resolve()),
					),
				)
				const body = find('.sync-confirm-modal__body')
				const footer = find('.sync-confirm-modal__footer')
				assert(
					conflictOptions.getBoundingClientRect().top >=
						find('fieldset').getBoundingClientRect().bottom,
					'Narrow modal did not stack options',
				)
				assert(
					body.scrollHeight > body.clientHeight,
					'Small viewport did not make the body scroll',
				)
				assert(
					modal.contentEl.scrollWidth <= modal.contentEl.clientWidth + 1,
					'Narrow modal overflowed horizontally',
				)
				assert(
					footer.getBoundingClientRect().bottom <=
						modal.modalEl.getBoundingClientRect().bottom + 1,
					'Footer escaped the modal',
				)
				assert(
					body.getBoundingClientRect().bottom <=
						footer.getBoundingClientRect().top + 1,
					'Body overlaps footer',
				)
				const mobileGeometry = geometry()
				for (const policy of Object.values(SyncPolicy)) {
					choose(policy)
					// Mobile rule content flows inside the body; outer frame and actions stay fixed.
					assertStable(mobileGeometry, ['dialog', 'footer', 'confirm'])
					if (policy !== SyncPolicy.TwoWay) {
						const policies = find(
							'.sync-confirm-modal__policies',
						).getBoundingClientRect()
						const rules = find(
							'.sync-confirm-modal__rules',
						).getBoundingClientRect()
						const gap = rules.top - policies.bottom
						assert(
							conflictOptions.getBoundingClientRect().height === 0,
							'Mobile one-way sync reserved space for hidden conflict controls',
						)
						assert(
							gap >= 0 && gap <= 16,
							'Mobile rules did not follow the direction choices without a blank block',
						)
					}
					assert(
						modal.contentEl.scrollWidth <= modal.contentEl.clientWidth + 1,
						'A confirmation label overflowed the narrow modal',
					)
				}
				choose(SyncPolicy.TwoWay)
				confirm.click()
				assert(
					confirmed.length === 1 &&
						confirmed[0].syncPolicy === SyncPolicy.TwoWay &&
						confirmed[0].conflictStrategy === ConflictStrategy.ServerPriority,
					'Confirmation lost the run selection',
				)
				assert(
					JSON.stringify({ settings, localSettings }) === before,
					'Confirmation changed saved defaults',
				)
			} finally {
				modal.close()
			}
			const cancelled = mount()
			try {
				cancelled.contentEl
					.querySelector<HTMLButtonElement>(
						'.sync-confirm-modal__actions button',
					)!
					.click()
				assert(confirmed.length === 1, 'Cancel executed synchronization')
				assert(
					JSON.stringify({ settings, localSettings }) === before,
					'Cancel changed saved defaults',
				)
			} finally {
				cancelled.close()
			}
			// Cover initial state before any click for every non-default pairing.
			for (const policy of Object.values(SyncPolicy)) {
				for (const strategy of Object.values(ConflictStrategy)) {
					const initial = new SyncConfirmModal(
						app,
						{ ...settings, conflictStrategy: strategy },
						{ ...localSettings, syncPolicy: policy },
						() => {},
					)
					initial.open()
					try {
						const options = initial.contentEl.querySelector(
							'.sync-confirm-modal__options',
						)!
						const checked = Array.from(
							options.querySelectorAll<HTMLInputElement>('input:checked'),
						).map((input) => input.value)
						assert(
							checked.length === 2 &&
								checked.includes(policy) &&
								checked.includes(strategy),
							'Initial checked state differs from saved settings',
						)
						const conflictOptions = options.querySelector<HTMLFieldSetElement>(
							'.sync-confirm-modal__conflicts',
						)!
						assert(
							getComputedStyle(conflictOptions).visibility ===
								(policy === SyncPolicy.TwoWay ? 'visible' : 'hidden'),
							'Initial layout differs from saved policy',
						)
						const action = initial.contentEl.querySelector('.mod-cta')!
						assert(
							action.textContent ===
								i18n.t(
									`sync.confirmModal.actions.${getSyncPolicyI18nKey(policy)}`,
								),
							'Initial confirmation action differs from saved policy',
						)
					} finally {
						initial.close()
					}
				}
			}
		}
	} finally {
		await i18n.changeLanguage(originalLanguage)
	}
}

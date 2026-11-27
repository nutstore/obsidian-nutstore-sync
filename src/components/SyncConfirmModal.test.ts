import type { App } from 'obsidian'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryVault } from '@test/harness/memory-vault'
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

describe('SyncConfirmModal behavior and per-run isolation', () => {
	const originalLanguage = i18n.language

	afterEach(async () => {
		document.body.replaceChildren()
		await i18n.changeLanguage(originalLanguage)
	})

	it.each(['en', 'zh'] as const)(
		'renders Unicode remote path safely, updates rules/CTA per policy, and isolates per-run selection (%s)',
		async (language) => {
			await i18n.changeLanguage(language)
			const app = new MemoryVault({ name: 'ConfirmModalVault' })
				.app as unknown as App
			const settings = {
				...DEFAULT_SETTINGS,
				remoteDir: '/Notes 笔记🌱/<draft> & examples/',
			}
			const localSettings = { ...DEFAULT_LOCAL_SETTINGS }
			const before = JSON.stringify({ settings, localSettings })
			const confirmed: SyncSelection[] = []

			const modal = new SyncConfirmModal(
				app,
				settings,
				localSettings,
				(value) => {
					confirmed.push(value)
				},
			)
			modal.open()

			const choose = (value: SyncPolicy | ConflictStrategy) => {
				const input = modal.contentEl.querySelector<HTMLInputElement>(
					`input[value="${value}"]`,
				)
				expect(input).not.toBeNull()
				input!.parentElement!.click()
				expect(input!.checked).toBe(true)
			}

			expect(modal.contentEl.querySelectorAll('input')).toHaveLength(9)
			const remoteEl = modal.contentEl.querySelector<HTMLElement>(
				'.sync-confirm-modal__remote',
			)!
			expect(remoteEl.textContent).toContain(settings.remoteDir)
			expect(remoteEl.children).toHaveLength(0)

			const conflictOptions =
				modal.contentEl.querySelector<HTMLFieldSetElement>(
					'.sync-confirm-modal__conflicts',
				)!
			const confirmBtn = modal.contentEl.querySelector<HTMLButtonElement>(
				'.sync-confirm-modal__actions .mod-cta',
			)!

			for (const strategy of Object.values(ConflictStrategy)) {
				choose(SyncPolicy.TwoWay)
				choose(strategy)
				expect(modal.contentEl.querySelector('tbody')?.textContent).toContain(
					i18n.t(
						`settings.conflictStrategy.${getConflictStrategyI18nKey(strategy)}`,
					),
				)
			}

			for (const [policy, rowCount] of [
				[SyncPolicy.TwoWay, 5],
				[SyncPolicy.SendOnly, 6],
				[SyncPolicy.SendOnlyOverrideChanges, 3],
				[SyncPolicy.ReceiveOnly, 6],
				[SyncPolicy.ReceiveOnlyRevertLocalChanges, 3],
			] as const) {
				choose(policy)
				expect(conflictOptions.disabled).toBe(policy !== SyncPolicy.TwoWay)
				expect(modal.contentEl.querySelectorAll('tbody tr')).toHaveLength(
					rowCount,
				)
				expect(confirmBtn.textContent).toBe(
					i18n.t(`sync.confirmModal.actions.${getSyncPolicyI18nKey(policy)}`),
				)
			}

			// Returning to TwoWay retains the previously chosen conflict strategy.
			choose(SyncPolicy.TwoWay)
			expect(
				modal.contentEl.querySelector<HTMLInputElement>(
					'input[value="server-priority"]',
				)?.checked,
			).toBe(true)

			confirmBtn.click()
			expect(confirmed).toEqual([
				{
					syncPolicy: SyncPolicy.TwoWay,
					conflictStrategy: ConflictStrategy.ServerPriority,
				},
			])
			expect(JSON.stringify({ settings, localSettings })).toBe(before)

			// Cancelling neither invokes onConfirm nor mutates defaults.
			const cancelled = new SyncConfirmModal(
				app,
				settings,
				localSettings,
				(value) => confirmed.push(value),
			)
			cancelled.open()
			cancelled.contentEl
				.querySelector<HTMLButtonElement>(
					'.sync-confirm-modal__actions button',
				)!
				.click()
			expect(confirmed).toHaveLength(1)
			expect(JSON.stringify({ settings, localSettings })).toBe(before)
		},
	)

	it('reflects every saved syncPolicy x conflictStrategy pair on initial open', async () => {
		await i18n.changeLanguage('en')
		const app = new MemoryVault({ name: 'ConfirmInitVault' })
			.app as unknown as App
		for (const policy of Object.values(SyncPolicy)) {
			for (const strategy of Object.values(ConflictStrategy)) {
				const modal = new SyncConfirmModal(
					app,
					{ ...DEFAULT_SETTINGS, conflictStrategy: strategy },
					{ ...DEFAULT_LOCAL_SETTINGS, syncPolicy: policy },
					() => {},
				)
				modal.open()
				const checked = Array.from(
					modal.contentEl.querySelectorAll<HTMLInputElement>(
						'.sync-confirm-modal__options input:checked',
					),
				).map((input) => input.value)
				expect(checked).toHaveLength(2)
				expect(checked).toContain(policy)
				expect(checked).toContain(strategy)
				expect(
					modal.contentEl.querySelector<HTMLFieldSetElement>(
						'.sync-confirm-modal__conflicts',
					)?.disabled,
				).toBe(policy !== SyncPolicy.TwoWay)
				expect(modal.contentEl.querySelector('.mod-cta')?.textContent).toBe(
					i18n.t(`sync.confirmModal.actions.${getSyncPolicyI18nKey(policy)}`),
				)
				modal.close()
			}
		}
	})
})

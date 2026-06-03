import { Show } from 'solid-js'
import { t } from '../i18n'

export function ConfirmDialog(props: {
	title: string | undefined
	message: string | undefined
	confirmLabel: string | undefined
	confirmClass?: string
	secondaryConfirmLabel?: string | undefined
	secondaryConfirmClass?: string
	onCancel: () => void
	onConfirm: () => void
	onSecondaryConfirm?: () => void
}) {
	return (
		<div class="absolute inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
			<div class="w-full max-w-sm rounded-4 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] p-4 shadow-xl">
				<div class="text-base font-semibold text-[var(--text-normal)]">
					{props.title}
				</div>
				<div class="mt-3 text-sm leading-6 text-[var(--text-muted)]">
					{props.message}
				</div>
				<div class="mt-4 flex justify-end gap-2">
					<button type="button" onClick={() => props.onCancel()}>
						{t('cancel')}
					</button>
					<Show when={props.secondaryConfirmLabel}>
						<button
							class={
								props.secondaryConfirmClass ??
								'rounded-2 border border-[var(--interactive-accent-rgb)]/30 bg-[var(--interactive-accent-rgb)]/12 px-3 py-2 text-sm text-[var(--text-normal)] hover:bg-[var(--interactive-accent-rgb)]/18'
							}
							type="button"
							onClick={() => props.onSecondaryConfirm?.()}
						>
							{props.secondaryConfirmLabel}
						</button>
					</Show>
					<button
						class={
							props.confirmClass ??
							'rounded-2 border border-[var(--color-red-rgb)]/30 bg-[var(--color-red-rgb)]/12 px-3 py-2 text-sm text-[var(--text-error)] hover:bg-[var(--color-red-rgb)]/18'
						}
						type="button"
						onClick={() => props.onConfirm()}
					>
						{props.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	)
}

import { Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { t } from '../../i18n'

/** Everything a confirmation prompt shows and does, apart from where it mounts. */
export interface ConfirmDialogView {
	title: string | undefined
	message: string | undefined
	confirmLabel: string | undefined
	confirmClass?: string
	secondaryConfirmLabel?: string | undefined
	secondaryConfirmClass?: string
	actionsLayout?: 'horizontal' | 'vertical'
	cancelPlacement?: 'start' | 'end'
	onConfirm: () => void
	onSecondaryConfirm?: () => void
}

export function ConfirmDialog(props: {
	view: ConfirmDialogView
	mountEl: HTMLElement
	contained: boolean
	onCancel: () => void
}) {
	const view = () => props.view
	const actionsClass = () =>
		view().actionsLayout === 'vertical'
			? ':uno: mt-4 flex flex-col gap-2'
			: ':uno: mt-4 flex justify-end gap-2'
	const cancelButton = () => (
		<button
			class={view().actionsLayout === 'vertical' ? ':uno: w-full' : undefined}
			type="button"
			onClick={() => props.onCancel()}
		>
			{t('chatbox.ui.actions.cancel')}
		</button>
	)
	const actionButtonClass = (buttonClass?: string) =>
		`${view().actionsLayout === 'vertical' ? ':uno: w-full' : ''} ${buttonClass ?? ''}`.trim()

	return (
		<Portal mount={props.mountEl}>
			<div
				class={[
					':uno: inset-0 z-[220] flex items-center justify-center bg-black/40 px-4',
					props.contained ? ':uno: absolute' : ':uno: fixed',
				].join(' ')}
			>
				<div class=":uno: w-full max-w-sm rounded-4 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] p-4 shadow-xl">
					<div class=":uno: text-base font-semibold text-[var(--text-normal)]">
						{view().title}
					</div>
					<div class=":uno: mt-3 text-sm leading-6 text-[var(--text-muted)]">
						{view().message}
					</div>
					<div class={actionsClass()}>
						<Show when={view().cancelPlacement !== 'end'}>
							{cancelButton()}
						</Show>
						<Show when={view().secondaryConfirmLabel}>
							<button
								class={actionButtonClass(view().secondaryConfirmClass)}
								type="button"
								onClick={() => view().onSecondaryConfirm?.()}
							>
								{view().secondaryConfirmLabel}
							</button>
						</Show>
						<button
							class={actionButtonClass(view().confirmClass)}
							type="button"
							onClick={() => view().onConfirm()}
						>
							{view().confirmLabel}
						</button>
						<Show when={view().cancelPlacement === 'end'}>
							{cancelButton()}
						</Show>
					</div>
				</div>
			</div>
		</Portal>
	)
}

import { Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { t } from '../../i18n'

export function ConfirmDialog(props: {
	title: string | undefined
	message: string | undefined
	confirmLabel: string | undefined
	confirmClass?: string
	secondaryConfirmLabel?: string | undefined
	secondaryConfirmClass?: string
	mountEl: HTMLElement
	contained: boolean
	actionsLayout?: 'horizontal' | 'vertical'
	cancelPlacement?: 'start' | 'end'
	onCancel: () => void
	onConfirm: () => void
	onSecondaryConfirm?: () => void
}) {
	const actionsClass = () =>
		props.actionsLayout === 'vertical'
			? ':uno: mt-4 flex flex-col gap-2'
			: ':uno: mt-4 flex justify-end gap-2'
	const cancelButton = () => (
		<button
			class={props.actionsLayout === 'vertical' ? ':uno: w-full' : undefined}
			type="button"
			onClick={() => props.onCancel()}
		>
			{t('chatbox.ui.actions.cancel')}
		</button>
	)
	const actionButtonClass = (buttonClass?: string) =>
		`${props.actionsLayout === 'vertical' ? ':uno: w-full' : ''} ${buttonClass ?? ''}`.trim()

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
						{props.title}
					</div>
					<div class=":uno: mt-3 text-sm leading-6 text-[var(--text-muted)]">
						{props.message}
					</div>
					<div class={actionsClass()}>
						<Show when={props.cancelPlacement !== 'end'}>{cancelButton()}</Show>
						<Show when={props.secondaryConfirmLabel}>
							<button
								class={actionButtonClass(props.secondaryConfirmClass)}
								type="button"
								onClick={() => props.onSecondaryConfirm?.()}
							>
								{props.secondaryConfirmLabel}
							</button>
						</Show>
						<button
							class={actionButtonClass(props.confirmClass)}
							type="button"
							onClick={() => props.onConfirm()}
						>
							{props.confirmLabel}
						</button>
						<Show when={props.cancelPlacement === 'end'}>{cancelButton()}</Show>
					</div>
				</div>
			</div>
		</Portal>
	)
}

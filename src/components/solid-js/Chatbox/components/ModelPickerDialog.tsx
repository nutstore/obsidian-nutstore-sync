import { Index, createEffect } from 'solid-js'
import { Portal } from 'solid-js/web'

import type { ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '../../i18n'

export function ModelPickerDialog(props: {
	providers: ChatboxProps['providers']
	selectedProviderId?: string
	selectedModelId?: string
	mountEl: HTMLElement
	contained: boolean
	onSelectProvider: (providerId: string) => void
	onSelectModel: (modelId: string) => void
	onClose: () => void
}) {
	let providerSelectEl: HTMLSelectElement | undefined
	let modelSelectEl: HTMLSelectElement | undefined

	const selectedProvider = () =>
		props.providers.find((provider) => provider.id === props.selectedProviderId)

	// Replacing or reordering <option> nodes causes native <select> elements to
	// fall back to index 0 ("") even when selectedProviderId/selectedModelId did
	// not change; re-sync the DOM value after option updates commit.
	createEffect(() => {
		const target = props.selectedProviderId || ''
		const hasTarget =
			!target || props.providers.some((provider) => provider.id === target)
		const nextValue = hasTarget ? target : ''
		if (providerSelectEl && providerSelectEl.value !== nextValue) {
			providerSelectEl.value = nextValue
		}
	})

	createEffect(() => {
		const target = props.selectedModelId || ''
		const models = selectedProvider()?.models || []
		const hasTarget = !target || models.some((model) => model.id === target)
		const nextValue = hasTarget ? target : ''
		if (modelSelectEl && modelSelectEl.value !== nextValue) {
			modelSelectEl.value = nextValue
		}
	})

	return (
		<Portal mount={props.mountEl}>
			<div
				class={[
					':uno: inset-0 z-[220] flex items-center justify-center bg-black/40 p-4',
					props.contained ? ':uno: absolute' : ':uno: fixed',
				].join(' ')}
				onPointerDown={(event) => {
					if (event.target === event.currentTarget) props.onClose()
				}}
			>
				<div class=":uno: w-full max-w-sm rounded-4 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] p-4 shadow-xl">
					<div class=":uno: flex items-center justify-between gap-3">
						<div class=":uno: text-base font-semibold text-[var(--text-normal)]">
							{t('chatbox.ui.labels.provider')} / {t('chatbox.ui.labels.model')}
						</div>
						<button
							class=":uno: text-sm text-[var(--text-muted)] hover:text-[var(--text-normal)]"
							type="button"
							onClick={() => props.onClose()}
						>
							{t('chatbox.ui.actions.close')}
						</button>
					</div>
					<div class=":uno: mt-4 text-xs text-[var(--text-muted)]">
						{t('chatbox.ui.labels.provider')}
					</div>
					<select
						ref={providerSelectEl}
						class=":uno: mt-2 w-full border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] px-2 py-1 text-[var(--text-normal)] disabled:cursor-not-allowed disabled:opacity-50"
						value={props.selectedProviderId || ''}
						onChange={(event) =>
							props.onSelectProvider(event.currentTarget.value)
						}
					>
						<option value="">{t('chatbox.ui.states.noProvider')}</option>
						<Index each={props.providers}>
							{(provider) => (
								<option value={provider().id}>{provider().name}</option>
							)}
						</Index>
					</select>
					<div class=":uno: mt-4 text-xs text-[var(--text-muted)]">
						{t('chatbox.ui.labels.model')}
					</div>
					<select
						ref={modelSelectEl}
						class=":uno: mt-2 w-full border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] px-2 py-1 text-[var(--text-normal)] disabled:cursor-not-allowed disabled:opacity-50"
						value={props.selectedModelId || ''}
						disabled={!selectedProvider()?.models.length}
						onChange={(event) => {
							props.onSelectModel(event.currentTarget.value)
							props.onClose()
						}}
					>
						<option value="">{t('chatbox.ui.states.noModel')}</option>
						<Index each={selectedProvider()?.models || []}>
							{(model) => <option value={model().id}>{model().name}</option>}
						</Index>
					</select>
				</div>
			</div>
		</Portal>
	)
}

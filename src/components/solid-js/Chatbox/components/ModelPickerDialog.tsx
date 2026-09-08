import { For } from 'solid-js'
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
	const selectedProvider = () =>
		props.providers.find((provider) => provider.id === props.selectedProviderId)

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
						class=":uno: mt-2 w-full border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] px-2 py-1 text-[var(--text-normal)] disabled:cursor-not-allowed disabled:opacity-50"
						value={props.selectedProviderId || ''}
						onChange={(event) =>
							props.onSelectProvider(event.currentTarget.value)
						}
					>
						<option value="">{t('chatbox.ui.states.noProvider')}</option>
						<For each={props.providers}>
							{(provider) => (
								<option value={provider.id}>{provider.name}</option>
							)}
						</For>
					</select>
					<div class=":uno: mt-4 text-xs text-[var(--text-muted)]">
						{t('chatbox.ui.labels.model')}
					</div>
					<select
						class=":uno: mt-2 w-full border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] px-2 py-1 text-[var(--text-normal)] disabled:cursor-not-allowed disabled:opacity-50"
						value={props.selectedModelId || ''}
						disabled={!selectedProvider()?.models.length}
						onChange={(event) => {
							props.onSelectModel(event.currentTarget.value)
							props.onClose()
						}}
					>
						<option value="">{t('chatbox.ui.states.noModel')}</option>
						<For each={selectedProvider()?.models || []}>
							{(model) => <option value={model.id}>{model.name}</option>}
						</For>
					</select>
				</div>
			</div>
		</Portal>
	)
}

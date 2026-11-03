import {
	For,
	Show,
	createMemo,
	createSignal,
	createUniqueId,
	onMount,
} from 'solid-js'
import { Portal } from 'solid-js/web'
import type { AIModelConfig } from '~/ai/core/types'
import { isFuzzySubsequenceMatch } from '~/utils/fuzzy-match'
import { t } from '../../i18n'

export function modelName(model: AIModelConfig) {
	return model.name || model.id
}

interface DiscoveredModelsDialogProps {
	models: AIModelConfig[]
	isAdded: (modelId: string) => boolean
	mountEl: HTMLElement
	onAdd: (selected: AIModelConfig[]) => void
	onClose: () => void
}

// Mobile-first picker: bottom sheet on narrow screens, centered dialog otherwise.
export function DiscoveredModelsDialog(props: DiscoveredModelsDialogProps) {
	const titleId = createUniqueId()
	const [query, setQuery] = createSignal('')
	const [selectedIds, setSelectedIds] = createSignal(new Set<string>())
	let searchEl: HTMLInputElement | undefined

	// Keyboard focus must live inside the dialog for Escape to reach it.
	onMount(() => searchEl?.focus())

	const visibleModels = createMemo(() => {
		const q = query().trim()
		if (!q) return props.models
		return props.models.filter(
			(model) =>
				isFuzzySubsequenceMatch(q, model.id) ||
				isFuzzySubsequenceMatch(q, modelName(model)),
		)
	})
	const selectableVisible = () =>
		visibleModels().filter((model) => !props.isAdded(model.id))
	const allVisibleSelected = () =>
		selectableVisible().length > 0 &&
		selectableVisible().every((model) => selectedIds().has(model.id))

	function toggleModel(modelId: string) {
		setSelectedIds((current) => {
			const next = new Set(current)
			if (next.has(modelId)) next.delete(modelId)
			else next.add(modelId)
			return next
		})
	}

	function toggleAllVisible() {
		const ids = selectableVisible().map((model) => model.id)
		const clear = allVisibleSelected()
		setSelectedIds((current) => {
			const next = new Set(current)
			for (const id of ids) {
				if (clear) next.delete(id)
				else next.add(id)
			}
			return next
		})
	}

	function confirm() {
		const selected = props.models.filter((model) => selectedIds().has(model.id))
		if (selected.length === 0) return
		props.onAdd(selected)
	}

	return (
		<Portal mount={props.mountEl}>
			<div
				class=":uno: fixed inset-0 z-[220] flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
				onPointerDown={(event) => {
					if (event.target === event.currentTarget) props.onClose()
				}}
				// Native listener: Solid's delegated events cannot stop Obsidian's
				// window-level Escape handling, which would close the host modal.
				on:keydown={(event) => {
					if (event.key !== 'Escape') return
					event.preventDefault()
					event.stopPropagation()
					props.onClose()
				}}
			>
				<div
					role="dialog"
					aria-modal="true"
					aria-labelledby={titleId}
					class=":uno: flex max-h-[85vh] w-full flex-col gap-3 rounded-t-4 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl sm:max-w-lg sm:rounded-4"
				>
					<header class=":uno: flex flex-col gap-1">
						<h2 id={titleId} class=":uno: text-base font-semibold">
							{t('chatbox.setup.custom.pickModelsTitle')}
						</h2>
						<p class=":uno: text-xs text-[var(--text-muted)]">
							{t('chatbox.setup.custom.pickModelsDescription')}
						</p>
					</header>

					<div class=":uno: flex items-center gap-2">
						<input
							ref={searchEl}
							class=":uno: ns-provider-stepper__model-search min-w-0 flex-1"
							type="search"
							value={query()}
							autocomplete="off"
							placeholder={t('chatbox.setup.custom.searchModels')}
							aria-label={t('chatbox.setup.custom.searchModels')}
							onInput={(event) => setQuery(event.currentTarget.value)}
						/>
						<button
							type="button"
							class=":uno: shrink-0 whitespace-nowrap px-2 py-1 text-sm text-[var(--text-muted)] hover:text-[var(--text-normal)]"
							disabled={selectableVisible().length === 0}
							onClick={toggleAllVisible}
						>
							{allVisibleSelected()
								? t('chatbox.setup.custom.deselectAll')
								: t('chatbox.setup.custom.selectAll')}
						</button>
					</div>

					<div class=":uno: flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
						<Show
							when={visibleModels().length > 0}
							fallback={
								<p class=":uno: py-6 text-center text-sm text-[var(--text-muted)]">
									{t('chatbox.setup.custom.noMatchingModels')}
								</p>
							}
						>
							<For each={visibleModels()}>
								{(model) => {
									const added = () => props.isAdded(model.id)
									return (
										<label
											class="ns-provider-stepper__model-option"
											classList={{ 'is-added': added() }}
										>
											<input
												type="checkbox"
												disabled={added()}
												checked={added() || selectedIds().has(model.id)}
												onChange={() => toggleModel(model.id)}
											/>
											<span>
												<strong>{modelName(model)}</strong>
												<span>{model.id}</span>
											</span>
											<Show when={added()}>
												<em>{t('chatbox.setup.custom.added')}</em>
											</Show>
										</label>
									)
								}}
							</For>
						</Show>
					</div>

					<div class=":uno: flex justify-end gap-2 border-t border-[var(--background-modifier-border)] pt-3">
						<button
							type="button"
							class="ns-provider-stepper__button is-secondary"
							onClick={() => props.onClose()}
						>
							{t('chatbox.setup.custom.cancel')}
						</button>
						<button
							type="button"
							class="mod-cta ns-provider-stepper__button"
							disabled={selectedIds().size === 0}
							onClick={confirm}
						>
							{t('chatbox.setup.custom.addSelected')}
							<span class=":uno: ml-1 text-xs">({selectedIds().size})</span>
						</button>
					</div>
				</div>
			</div>
		</Portal>
	)
}

import { For, Show, createMemo, createSignal, createUniqueId } from 'solid-js'
import type {
	ChatNutstoreSetupState,
	ChatProviderSetupDraft,
	ProviderSetupState,
} from '~/ai/chat/ui/types'
import {
	createProviderFromPreset,
	listPresetProviders,
} from '~/ai/catalog/config'
import type { AIModelConfig } from '~/ai/core/types'
import { getProviderDefaultBaseURL } from '~/ai/providers/defaults'
import { PROVIDER_API_FORMAT_OPTIONS } from '~/components/provider-api-formats'
import { isFuzzySubsequenceMatch } from '~/utils/fuzzy-match'
import { t } from '../../i18n'

type SetupRoute = 'choice' | 'nutstore' | 'custom'
type CustomStep = 'provider' | 'connection' | 'models' | 'review'
type BusyAction = 'authorizing' | 'fetching' | 'saving'

interface ProviderSetupProps {
	state: ProviderSetupState
	initialDraft?: ChatProviderSetupDraft
	nutstore: ChatNutstoreSetupState
	onStartNutstoreSetup: () => Promise<void>
	onOpenNutstoreAuthorization: () => Promise<void>
	onCancelNutstoreSetup: () => Promise<void>
	onFetchProviderSetupModels: (
		draft: ChatProviderSetupDraft,
	) => Promise<AIModelConfig[]>
	onCreateProviderSetupModel: (
		modelId: string,
		providerApi?: string,
	) => AIModelConfig
	onSaveProviderSetup: (draft: ChatProviderSetupDraft) => Promise<void>
}

function errorMessage(
	error: unknown,
	fallbackKey: Parameters<typeof t>[0],
): string {
	return error instanceof Error && error.message
		? error.message
		: (t(fallbackKey) as string)
}

function modelName(model: AIModelConfig) {
	return model.name || model.id
}

function providerInitial(name: string) {
	return Array.from(name.trim())[0]?.toLocaleUpperCase() || '?'
}

export function ProviderSetup(props: ProviderSetupProps) {
	const titleId = createUniqueId()
	const descriptionId = createUniqueId()
	const presetProviders = listPresetProviders()
	const existingDraft = props.initialDraft
	const existingConnectionReady = !!(
		existingDraft?.name.trim() &&
		existingDraft.apiKey.trim() &&
		(existingDraft.api?.trim() || getProviderDefaultBaseURL(existingDraft.npm))
	)
	const initialCustomStep: CustomStep = existingConnectionReady
		? 'models'
		: 'connection'

	const [route, setRoute] = createSignal<SetupRoute>(
		existingDraft ? 'custom' : 'choice',
	)
	const [customStep, setCustomStep] =
		createSignal<CustomStep>(initialCustomStep)
	const [name, setName] = createSignal(existingDraft?.name ?? '')
	const [npm, setNpm] = createSignal(
		existingDraft?.npm ?? PROVIDER_API_FORMAT_OPTIONS[0].value,
	)
	const [api, setApi] = createSignal(existingDraft?.api ?? '')
	const [apiKey, setApiKey] = createSignal(existingDraft?.apiKey ?? '')
	const [allowBrowserCors, setAllowBrowserCors] = createSignal(
		existingDraft?.allowBrowserCors ?? false,
	)
	const [models, setModels] = createSignal<Record<string, AIModelConfig>>(
		existingDraft?.models ?? {},
	)
	const [discoveredModels, setDiscoveredModels] = createSignal<AIModelConfig[]>(
		[],
	)
	const [selectedDiscoveredIds, setSelectedDiscoveredIds] = createSignal(
		new Set<string>(),
	)
	const [modelSearch, setModelSearch] = createSignal('')
	const [providerSearch, setProviderSearch] = createSignal('')
	const [manualModelId, setManualModelId] = createSignal('')
	const [busyAction, setBusyAction] = createSignal<BusyAction>()
	const [error, setError] = createSignal<string>()

	const isExistingProvider = () => !!existingDraft?.existingProviderId
	const isBusy = () => busyAction() !== undefined
	const selectedModelList = createMemo(() =>
		Object.values(models()).sort((left, right) =>
			left.id.localeCompare(right.id, undefined, { numeric: true }),
		),
	)
	const filteredPresetProviders = createMemo(() => {
		const query = providerSearch()
		if (!query.trim()) return presetProviders
		return presetProviders.filter(
			(provider) =>
				isFuzzySubsequenceMatch(query, provider.name) ||
				isFuzzySubsequenceMatch(query, provider.id),
		)
	})
	const filteredDiscoveredModels = createMemo(() => {
		const query = modelSearch()
		if (!query.trim()) return discoveredModels()
		return discoveredModels().filter(
			(model) =>
				isFuzzySubsequenceMatch(query, model.id) ||
				isFuzzySubsequenceMatch(query, modelName(model)),
		)
	})
	const apiFormatOptions = createMemo(() => {
		const options: Array<{ value: string; label: string }> =
			PROVIDER_API_FORMAT_OPTIONS.map((option) => ({
				value: option.value,
				label: t(option.labelKey),
			}))
		if (!options.some((option) => option.value === npm())) {
			options.push({
				value: npm(),
				label: t('settings.ai.provider.apiFormat.other', { npm: npm() }),
			})
		}
		return options
	})
	const stepItems = createMemo(() => {
		if (route() === 'choice') {
			return [
				t('chatbox.setup.steps.choose'),
				t('chatbox.setup.steps.connection'),
				t('chatbox.setup.steps.models'),
				t('chatbox.setup.steps.ready'),
			]
		}
		if (route() === 'nutstore') {
			return [
				t('chatbox.setup.steps.choose'),
				t('chatbox.setup.steps.authorize'),
			]
		}
		return [
			t('chatbox.setup.steps.provider'),
			t('chatbox.setup.steps.connection'),
			t('chatbox.setup.steps.models'),
			t('chatbox.setup.steps.ready'),
		]
	})
	const currentStep = createMemo(() => {
		if (route() === 'choice') return 0
		if (route() === 'nutstore') return 1
		if (customStep() === 'provider') return 0
		if (customStep() === 'connection') return 1
		if (customStep() === 'models') return 2
		return 3
	})
	const title = createMemo(() => {
		if (route() === 'choice') return t('chatbox.setup.choice.title')
		if (route() === 'nutstore') return t('chatbox.setup.nutstore.title')
		if (customStep() === 'provider') {
			return t('chatbox.setup.custom.providerTitle')
		}
		if (customStep() === 'connection') {
			return t('chatbox.setup.custom.connectionTitle')
		}
		if (customStep() === 'models') {
			return t('chatbox.setup.custom.modelsTitle')
		}
		return t('chatbox.setup.custom.reviewTitle')
	})
	const description = createMemo(() => {
		if (route() === 'choice') return t('chatbox.setup.choice.description')
		if (route() === 'nutstore') {
			return t('chatbox.setup.nutstore.description')
		}
		if (customStep() === 'provider') {
			return t('chatbox.setup.custom.providerDescription')
		}
		if (customStep() === 'connection') {
			return t('chatbox.setup.custom.connectionDescription')
		}
		if (customStep() === 'models') {
			return t('chatbox.setup.custom.modelsDescription')
		}
		return t('chatbox.setup.custom.reviewDescription')
	})

	function clearError() {
		setError(undefined)
	}

	function chooseCustomProvider() {
		clearError()
		setRoute('custom')
		setProviderSearch('')
		setCustomStep(isExistingProvider() ? initialCustomStep : 'provider')
	}

	function chooseNutstore() {
		clearError()
		setRoute('nutstore')
	}

	function applyCustomDraft(draft: ChatProviderSetupDraft) {
		setName(draft.name)
		setNpm(draft.npm)
		setApi(draft.api ?? '')
		setApiKey(draft.apiKey)
		setAllowBrowserCors(draft.allowBrowserCors)
		setModels(draft.models)
		setDiscoveredModels([])
		setSelectedDiscoveredIds(new Set<string>())
		setModelSearch('')
		setManualModelId('')
		setCustomStep('connection')
	}

	function choosePresetProvider(presetId: string) {
		const preset = presetProviders.find((provider) => provider.id === presetId)
		if (!preset) return
		clearError()
		const provider = createProviderFromPreset(preset, '')
		applyCustomDraft({
			name: provider.name,
			npm: provider.npm,
			api: provider.api,
			apiKey: provider.apiKey,
			allowBrowserCors: provider.allowBrowserCors ?? false,
			models: provider.models,
		})
	}

	function chooseManualProvider() {
		clearError()
		applyCustomDraft({
			name: '',
			npm: PROVIDER_API_FORMAT_OPTIONS[0].value,
			apiKey: '',
			allowBrowserCors: false,
			models: {},
		})
	}

	function snapshotDraft(): ChatProviderSetupDraft {
		return {
			existingProviderId: existingDraft?.existingProviderId,
			name: name().trim(),
			npm: npm(),
			api: api().trim() || undefined,
			apiKey: apiKey().trim(),
			allowBrowserCors: allowBrowserCors(),
			models: models(),
		}
	}

	function validateConnection() {
		if (!name().trim()) {
			setError(String(t('chatbox.setup.errors.nameRequired')))
			return false
		}
		if (!apiKey().trim()) {
			setError(String(t('chatbox.errors.apiKeyRequired')))
			return false
		}
		if (!api().trim() && !getProviderDefaultBaseURL(npm())) {
			setError(String(t('chatbox.errors.providerBaseUrlRequired')))
			return false
		}
		clearError()
		return true
	}

	function continueToModels() {
		if (!validateConnection()) return
		setCustomStep('models')
	}

	async function fetchModels() {
		if (!validateConnection() || isBusy()) return
		setBusyAction('fetching')
		clearError()
		try {
			const discovered = await props.onFetchProviderSetupModels(snapshotDraft())
			setDiscoveredModels(discovered)
			setSelectedDiscoveredIds(new Set<string>())
			setModelSearch('')
			if (discovered.length === 0) {
				setError(String(t('chatbox.setup.custom.noModelsFound')))
			}
		} catch (cause) {
			setError(errorMessage(cause, 'chatbox.setup.errors.fetchFailed'))
		} finally {
			setBusyAction(undefined)
		}
	}

	function toggleDiscoveredModel(modelId: string) {
		if (models()[modelId]) return
		setSelectedDiscoveredIds((current) => {
			const next = new Set(current)
			if (next.has(modelId)) next.delete(modelId)
			else next.add(modelId)
			return next
		})
	}

	function addSelectedDiscoveredModels() {
		const selected = discoveredModels().filter((model) =>
			selectedDiscoveredIds().has(model.id),
		)
		if (selected.length === 0) {
			setError(String(t('chatbox.setup.custom.noModelsSelected')))
			return
		}
		setModels((current) => ({
			...current,
			...Object.fromEntries(selected.map((model) => [model.id, model])),
		}))
		setSelectedDiscoveredIds(new Set<string>())
		clearError()
	}

	function addManualModel() {
		const modelId = manualModelId().trim()
		if (!modelId) {
			setError(String(t('settings.ai.errors.emptyModelId')))
			return
		}
		if (models()[modelId]) {
			setError(String(t('settings.ai.errors.duplicateModelId')))
			return
		}
		const model = props.onCreateProviderSetupModel(modelId, api())
		setModels((current) => ({ ...current, [model.id]: model }))
		setManualModelId('')
		clearError()
	}

	function removeModel(modelId: string) {
		setModels((current) => {
			const { [modelId]: _removed, ...remaining } = current
			return remaining
		})
	}

	function continueToReview() {
		if (selectedModelList().length === 0) {
			setError(String(t('chatbox.setup.errors.modelRequired')))
			return
		}
		clearError()
		setCustomStep('review')
	}

	async function saveProvider() {
		if (isBusy()) return
		setBusyAction('saving')
		clearError()
		try {
			await props.onSaveProviderSetup(snapshotDraft())
		} catch (cause) {
			setError(errorMessage(cause, 'chatbox.setup.errors.saveFailed'))
		} finally {
			setBusyAction(undefined)
		}
	}

	async function startNutstoreSetup() {
		if (isBusy()) return
		setBusyAction('authorizing')
		clearError()
		try {
			await props.onStartNutstoreSetup()
		} catch (cause) {
			setError(errorMessage(cause, 'chatbox.setup.errors.authorizationFailed'))
		} finally {
			setBusyAction(undefined)
		}
	}

	async function openNutstoreAuthorization() {
		if (isBusy()) return
		clearError()
		try {
			await props.onOpenNutstoreAuthorization()
		} catch (cause) {
			setError(errorMessage(cause, 'chatbox.setup.errors.authorizationFailed'))
		}
	}

	async function returnFromNutstore() {
		if (isBusy()) return
		if (props.nutstore.status === 'authorizing') {
			setBusyAction('authorizing')
			try {
				await props.onCancelNutstoreSetup()
			} catch (cause) {
				setError(
					errorMessage(cause, 'chatbox.setup.errors.cancelAuthorizationFailed'),
				)
				return
			} finally {
				setBusyAction(undefined)
			}
		}
		clearError()
		setRoute('choice')
	}

	function backFromCustomStep() {
		clearError()
		if (customStep() === 'review') {
			setCustomStep('models')
			return
		}
		if (customStep() === 'models') {
			setCustomStep('connection')
			return
		}
		if (customStep() === 'connection' && !isExistingProvider()) {
			setCustomStep('provider')
			return
		}
		setRoute('choice')
	}

	return (
		<section
			class="ns-provider-stepper"
			aria-labelledby={titleId}
			aria-describedby={descriptionId}
		>
			<div class="ns-provider-stepper__shell">
				<header class="ns-provider-stepper__heading">
					<div class="ns-provider-stepper__eyebrow">
						{props.state.kind === 'no-model'
							? t('chatbox.setup.continueEyebrow', {
									provider: props.state.providerName,
								})
							: t('chatbox.setup.eyebrow')}
					</div>
					<h1 id={titleId} class="ns-provider-stepper__title">
						{title()}
					</h1>
					<p id={descriptionId} class="ns-provider-stepper__description">
						{description()}
					</p>
				</header>

				<ol
					class="ns-provider-stepper__progress"
					aria-label={t('chatbox.setup.progressLabel')}
				>
					<For each={stepItems()}>
						{(step, index) => {
							const state = () => {
								if (index() < currentStep()) return 'complete'
								if (index() === currentStep()) return 'current'
								return 'upcoming'
							}
							return (
								<li
									class={`ns-provider-stepper__progress-item is-${state()}`}
									aria-current={state() === 'current' ? 'step' : undefined}
								>
									<span class="ns-provider-stepper__progress-index">
										<Show when={state() === 'complete'} fallback={index() + 1}>
											<span class=":uno: i-lucide-check size-3.5" />
										</Show>
									</span>
									<span class="ns-provider-stepper__progress-label">
										{step}
									</span>
								</li>
							)
						}}
					</For>
				</ol>

				<div class="ns-provider-stepper__panel">
					<Show when={route() === 'choice'}>
						<div class="ns-provider-stepper__choices">
							<button
								type="button"
								class="ns-provider-stepper__choice is-featured"
								data-provider-setup-choice="nutstore"
								onClick={chooseNutstore}
							>
								<span class="ns-provider-stepper__choice-icon">
									<span class=":uno: i-lucide-cloud-cog size-5" />
								</span>
								<span class="ns-provider-stepper__choice-copy">
									<span class="ns-provider-stepper__choice-title">
										{t('chatbox.setup.choice.nutstoreTitle')}
									</span>
									<span class="ns-provider-stepper__choice-description">
										{t('chatbox.setup.choice.nutstoreDescription')}
									</span>
								</span>
								<span class="ns-provider-stepper__choice-badge">
									{t('chatbox.setup.choice.nutstoreBadge')}
								</span>
							</button>
							<button
								type="button"
								class="ns-provider-stepper__choice"
								data-provider-setup-choice="custom"
								onClick={chooseCustomProvider}
							>
								<span class="ns-provider-stepper__choice-icon">
									<span class=":uno: i-lucide-sliders-horizontal size-5" />
								</span>
								<span class="ns-provider-stepper__choice-copy">
									<span class="ns-provider-stepper__choice-title">
										{t('chatbox.setup.choice.customTitle')}
									</span>
									<span class="ns-provider-stepper__choice-description">
										{t('chatbox.setup.choice.customDescription')}
									</span>
								</span>
								<span class=":uno: i-lucide-arrow-right size-4 ns-provider-stepper__choice-arrow" />
							</button>
						</div>
					</Show>

					<Show when={route() === 'nutstore'}>
						<div class="ns-provider-stepper__nutstore">
							<div class="ns-provider-stepper__hero-icon">
								<span class=":uno: i-lucide-cloud-cog size-7" />
							</div>
							<Show
								when={props.nutstore.status === 'authorizing'}
								fallback={
									<>
										<div class="ns-provider-stepper__body-copy">
											<p>{t('chatbox.setup.nutstore.idleDescription')}</p>
											<ul class="ns-provider-stepper__benefits">
												<li>{t('chatbox.setup.nutstore.benefitAccount')}</li>
												<li>{t('chatbox.setup.nutstore.benefitModels')}</li>
												<li>{t('chatbox.setup.nutstore.benefitBilling')}</li>
											</ul>
										</div>
										<div class="ns-provider-stepper__actions">
											<button
												type="button"
												class="ns-provider-stepper__button is-secondary"
												disabled={isBusy()}
												onClick={() => void returnFromNutstore()}
											>
												{t('chatbox.setup.actions.back')}
											</button>
											<button
												type="button"
												class="mod-cta ns-provider-stepper__button"
												disabled={isBusy()}
												onClick={() => void startNutstoreSetup()}
											>
												<span class=":uno: i-lucide-external-link size-4" />
												{busyAction() === 'authorizing'
													? t('chatbox.setup.nutstore.starting')
													: t('chatbox.setup.nutstore.authorize')}
											</button>
										</div>
									</>
								}
							>
								<div class="ns-provider-stepper__authorization">
									<div class="ns-provider-stepper__authorization-title">
										{t('chatbox.setup.nutstore.waitingTitle')}
									</div>
									<p>{t('chatbox.setup.nutstore.waitingDescription')}</p>
									<div class="ns-provider-stepper__code" aria-live="polite">
										<span>{t('chatbox.setup.nutstore.codeLabel')}</span>
										<strong>{props.nutstore.userCode}</strong>
									</div>
									<div class="ns-provider-stepper__actions">
										<button
											type="button"
											class="ns-provider-stepper__button is-secondary"
											disabled={isBusy()}
											onClick={() => void returnFromNutstore()}
										>
											{t('chatbox.setup.nutstore.cancel')}
										</button>
										<button
											type="button"
											class="mod-cta ns-provider-stepper__button"
											disabled={isBusy()}
											onClick={() => void openNutstoreAuthorization()}
										>
											<span class=":uno: i-lucide-external-link size-4" />
											{t('chatbox.setup.nutstore.openPage')}
										</button>
									</div>
								</div>
							</Show>
						</div>
					</Show>

					<Show when={route() === 'custom' && customStep() === 'provider'}>
						<div class="ns-provider-stepper__provider-picker">
							<label class="ns-provider-stepper__provider-search">
								<span
									class=":uno: i-lucide-search size-4 ns-provider-stepper__provider-search-icon"
									aria-hidden="true"
								/>
								<input
									type="search"
									value={providerSearch()}
									autocomplete="off"
									spellcheck={false}
									placeholder={t('chatbox.setup.custom.searchProviders')}
									aria-label={t('chatbox.setup.custom.searchProviders')}
									onInput={(event) =>
										setProviderSearch(event.currentTarget.value)
									}
								/>
							</label>

							<div class="ns-provider-stepper__provider-options">
								<For each={filteredPresetProviders()}>
									{(preset) => (
										<button
											type="button"
											class="ns-provider-stepper__provider-option"
											data-provider-preset={preset.id}
											onClick={() => choosePresetProvider(preset.id)}
										>
											<span
												class="ns-provider-stepper__provider-avatar"
												aria-hidden="true"
											>
												{providerInitial(preset.name)}
											</span>
											<span class="ns-provider-stepper__provider-copy">
												<strong>{preset.name}</strong>
												<span>
													{t('chatbox.setup.custom.presetModelCount', {
														count: Object.keys(preset.models).length,
													})}
												</span>
											</span>
											<span class=":uno: i-lucide-arrow-right size-4" />
										</button>
									)}
								</For>
							</div>

							<Show when={filteredPresetProviders().length === 0}>
								<p class="ns-provider-stepper__provider-empty">
									{t('chatbox.setup.custom.noProviderResults')}
								</p>
							</Show>

							<button
								type="button"
								class="ns-provider-stepper__provider-manual"
								data-provider-preset="custom"
								onClick={chooseManualProvider}
							>
								<span class="ns-provider-stepper__choice-icon">
									<span class=":uno: i-lucide-sliders-horizontal size-5" />
								</span>
								<span class="ns-provider-stepper__provider-copy">
									<strong>{t('chatbox.setup.custom.manualTitle')}</strong>
									<span>{t('chatbox.setup.custom.manualDescription')}</span>
								</span>
								<span class=":uno: i-lucide-arrow-right size-4" />
							</button>

							<div class="ns-provider-stepper__actions">
								<button
									type="button"
									class="ns-provider-stepper__button is-secondary"
									onClick={backFromCustomStep}
								>
									{t('chatbox.setup.actions.back')}
								</button>
							</div>
						</div>
					</Show>

					<Show when={route() === 'custom' && customStep() === 'connection'}>
						<form
							class="ns-provider-stepper__form"
							onSubmit={(event) => {
								event.preventDefault()
								continueToModels()
							}}
						>
							<label class="ns-provider-stepper__field">
								<span class="ns-provider-stepper__field-label">
									{t('chatbox.setup.custom.nameLabel')}
								</span>
								<input
									type="text"
									value={name()}
									autocomplete="off"
									placeholder={t('chatbox.setup.custom.namePlaceholder')}
									onInput={(event) => setName(event.currentTarget.value)}
								/>
								<span class="ns-provider-stepper__field-hint">
									{t('chatbox.setup.custom.nameHint')}
								</span>
							</label>

							<label class="ns-provider-stepper__field">
								<span class="ns-provider-stepper__field-label">
									{t('chatbox.setup.custom.apiFormatLabel')}
								</span>
								<select
									value={npm()}
									onChange={(event) => setNpm(event.currentTarget.value)}
								>
									<For each={apiFormatOptions()}>
										{(option) => (
											<option value={option.value}>{option.label}</option>
										)}
									</For>
								</select>
								<span class="ns-provider-stepper__field-hint">
									{t('chatbox.setup.custom.apiFormatHint')}
								</span>
							</label>

							<label class="ns-provider-stepper__field">
								<span class="ns-provider-stepper__field-label">
									{t('chatbox.setup.custom.baseUrlLabel')}
								</span>
								<input
									type="url"
									value={api()}
									autocomplete="off"
									spellcheck={false}
									placeholder={
										getProviderDefaultBaseURL(npm()) ||
										'https://api.example.com/v1'
									}
									onInput={(event) => setApi(event.currentTarget.value)}
								/>
								<span class="ns-provider-stepper__field-hint">
									{t('chatbox.setup.custom.baseUrlHint')}
								</span>
							</label>

							<label class="ns-provider-stepper__field">
								<span class="ns-provider-stepper__field-label">
									{t('chatbox.setup.custom.apiKeyLabel')}
								</span>
								<input
									type="password"
									value={apiKey()}
									autocomplete="off"
									placeholder={t('chatbox.setup.custom.apiKeyPlaceholder')}
									onInput={(event) => setApiKey(event.currentTarget.value)}
								/>
								<span class="ns-provider-stepper__field-hint">
									{t('chatbox.setup.custom.apiKeyHint')}
								</span>
							</label>

							<label class="ns-provider-stepper__toggle">
								<input
									type="checkbox"
									checked={allowBrowserCors()}
									onChange={(event) =>
										setAllowBrowserCors(event.currentTarget.checked)
									}
								/>
								<span>
									<strong>{t('chatbox.setup.custom.corsLabel')}</strong>
									<span>{t('chatbox.setup.custom.corsHint')}</span>
								</span>
							</label>

							<div class="ns-provider-stepper__actions">
								<button
									type="button"
									class="ns-provider-stepper__button is-secondary"
									onClick={backFromCustomStep}
								>
									{t('chatbox.setup.actions.back')}
								</button>
								<button
									type="submit"
									class="mod-cta ns-provider-stepper__button"
								>
									{t('chatbox.setup.actions.continue')}
									<span class=":uno: i-lucide-arrow-right size-4" />
								</button>
							</div>
						</form>
					</Show>

					<Show when={route() === 'custom' && customStep() === 'models'}>
						<div class="ns-provider-stepper__models">
							<div class="ns-provider-stepper__model-toolbar">
								<div>
									<div class="ns-provider-stepper__section-title">
										{t('chatbox.setup.custom.availableModelsTitle')}
									</div>
									<p>{t('chatbox.setup.custom.availableModelsHint')}</p>
								</div>
								<button
									type="button"
									class="ns-provider-stepper__button is-secondary"
									disabled={isBusy()}
									onClick={() => void fetchModels()}
								>
									<span class=":uno: i-lucide-refresh-cw size-4" />
									{busyAction() === 'fetching'
										? t('chatbox.setup.custom.fetching')
										: t('chatbox.setup.custom.fetchModels')}
								</button>
							</div>

							<Show when={discoveredModels().length > 0}>
								<div class="ns-provider-stepper__model-picker">
									<input
										type="search"
										value={modelSearch()}
										placeholder={t('chatbox.setup.custom.searchModels')}
										onInput={(event) =>
											setModelSearch(event.currentTarget.value)
										}
									/>
									<div class="ns-provider-stepper__model-options">
										<For each={filteredDiscoveredModels()}>
											{(model) => {
												const added = () => !!models()[model.id]
												return (
													<label
														class="ns-provider-stepper__model-option"
														classList={{ 'is-added': added() }}
													>
														<input
															type="checkbox"
															disabled={added()}
															checked={
																added() || selectedDiscoveredIds().has(model.id)
															}
															onChange={() => toggleDiscoveredModel(model.id)}
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
									</div>
									<button
										type="button"
										class="ns-provider-stepper__button is-secondary"
										onClick={addSelectedDiscoveredModels}
									>
										{t('chatbox.setup.custom.addSelected')}
									</button>
								</div>
							</Show>

							<div class="ns-provider-stepper__manual-model">
								<div class="ns-provider-stepper__section-title">
									{t('chatbox.setup.custom.manualModelTitle')}
								</div>
								<p>{t('chatbox.setup.custom.manualModelHint')}</p>
								<div class="ns-provider-stepper__inline-form">
									<input
										type="text"
										value={manualModelId()}
										autocomplete="off"
										spellcheck={false}
										placeholder={t(
											'chatbox.setup.custom.manualModelPlaceholder',
										)}
										onInput={(event) =>
											setManualModelId(event.currentTarget.value)
										}
										onKeyDown={(event) => {
											if (event.key === 'Enter') {
												event.preventDefault()
												addManualModel()
											}
										}}
									/>
									<button
										type="button"
										class="ns-provider-stepper__button is-secondary"
										onClick={addManualModel}
									>
										{t('chatbox.setup.custom.addModel')}
									</button>
								</div>
							</div>

							<div class="ns-provider-stepper__selected-models">
								<div class="ns-provider-stepper__section-title">
									{t('chatbox.setup.custom.selectedModelsTitle', {
										count: selectedModelList().length,
									})}
								</div>
								<Show
									when={selectedModelList().length > 0}
									fallback={
										<p>{t('chatbox.setup.custom.selectedModelsEmpty')}</p>
									}
								>
									<ul>
										<For each={selectedModelList()}>
											{(model) => (
												<li>
													<span>
														<strong>{modelName(model)}</strong>
														<span>{model.id}</span>
													</span>
													<button
														type="button"
														aria-label={t('chatbox.setup.custom.removeModel', {
															model: modelName(model),
														})}
														onClick={() => removeModel(model.id)}
													>
														<span class=":uno: i-lucide-x size-4" />
													</button>
												</li>
											)}
										</For>
									</ul>
								</Show>
							</div>

							<div class="ns-provider-stepper__actions">
								<button
									type="button"
									class="ns-provider-stepper__button is-secondary"
									onClick={backFromCustomStep}
								>
									{t('chatbox.setup.actions.back')}
								</button>
								<button
									type="button"
									class="mod-cta ns-provider-stepper__button"
									onClick={continueToReview}
								>
									{t('chatbox.setup.actions.review')}
									<span class=":uno: i-lucide-arrow-right size-4" />
								</button>
							</div>
						</div>
					</Show>

					<Show when={route() === 'custom' && customStep() === 'review'}>
						<div class="ns-provider-stepper__review">
							<dl class="ns-provider-stepper__summary">
								<div>
									<dt>{t('chatbox.setup.custom.reviewProvider')}</dt>
									<dd>{name()}</dd>
								</div>
								<div>
									<dt>{t('chatbox.setup.custom.reviewApiFormat')}</dt>
									<dd>
										{apiFormatOptions().find((option) => option.value === npm())
											?.label || npm()}
									</dd>
								</div>
								<div>
									<dt>{t('chatbox.setup.custom.reviewEndpoint')}</dt>
									<dd>
										{api().trim() ||
											getProviderDefaultBaseURL(npm()) ||
											t('settings.ai.providers.defaultEndpoint')}
									</dd>
								</div>
								<div>
									<dt>{t('chatbox.setup.custom.reviewModels')}</dt>
									<dd>
										{selectedModelList()
											.map((model) => modelName(model))
											.join(' · ')}
									</dd>
								</div>
							</dl>
							<div class="ns-provider-stepper__review-note">
								<span class=":uno: i-lucide-circle-check-big size-4" />
								<span>{t('chatbox.setup.custom.reviewHint')}</span>
							</div>
						</div>

						<div class="ns-provider-stepper__actions">
							<button
								type="button"
								class="ns-provider-stepper__button is-secondary"
								disabled={isBusy()}
								onClick={backFromCustomStep}
							>
								{t('chatbox.setup.actions.back')}
							</button>
							<button
								type="button"
								class="mod-cta ns-provider-stepper__button"
								disabled={isBusy()}
								onClick={() => void saveProvider()}
							>
								<span class=":uno: i-lucide-sparkles size-4" />
								{busyAction() === 'saving'
									? t('chatbox.setup.actions.saving')
									: t('chatbox.setup.actions.finish')}
							</button>
						</div>
					</Show>

					<Show when={error()}>
						{(message) => (
							<div class="ns-provider-stepper__error" role="alert">
								<span class=":uno: i-lucide-circle-alert size-4" />
								<span>{message()}</span>
							</div>
						)}
					</Show>
				</div>
			</div>
		</section>
	)
}

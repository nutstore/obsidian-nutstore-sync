import {
	For,
	Match,
	Show,
	Switch,
	createEffect,
	createSignal,
	onCleanup,
} from 'solid-js'
import { ConfirmDialog } from './components/ConfirmDialog'
import { FragmentDivider } from './components/FragmentDivider'
import { MessageCard } from './components/MessageCard'
import { PaneResizer } from './components/PaneResizer'
import { PendingList } from './components/PendingList'
import { RunStateCard } from './components/RunStateCard'
import { SessionHistoryItem } from './components/SessionHistoryItem'
import { TasksPanel } from './components/TasksPanel'
import { t } from './i18n'
import type {
	ChatTimelineFragmentItem,
	ChatTimelineMessageItem,
	ChatboxProps,
} from './types'

export type AppProps = ChatboxProps

const DESKTOP_RESIZE_MEDIA_QUERY = '(pointer: fine) and (min-width: 1024px)'
const INPUT_HEIGHT_STORAGE_KEY = 'nutstore-sync.chatbox.desktop-input-height'
const DEFAULT_DESKTOP_INPUT_HEIGHT = 184
const DESKTOP_INPUT_MIN_HEIGHT = 120
const DESKTOP_INPUT_ABSOLUTE_MIN_HEIGHT = 72
const DESKTOP_MESSAGES_MIN_HEIGHT = 200
const RESIZER_HITBOX_HEIGHT = 10
const DESKTOP_INPUT_MAX_VIEWPORT_RATIO = 0.6

function App(props: AppProps) {
	const [input, setInput] = createSignal('')
	const [isComposing, setIsComposing] = createSignal(false)
	const [historyOpen, setHistoryOpen] = createSignal(false)
	const [tasksOpen, setTasksOpen] = createSignal(false)
	const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
	const [sessionPendingDeleteId, setSessionPendingDeleteId] =
		createSignal<string>()
	const [pendingDeleteMessage, setPendingDeleteMessage] =
		createSignal<ChatTimelineMessageItem>()
	const [pendingRegenerateMessage, setPendingRegenerateMessage] =
		createSignal<ChatTimelineMessageItem>()
	const [pendingRecallMessage, setPendingRecallMessage] =
		createSignal<ChatTimelineMessageItem>()
	const [desktopResizeEnabled, setDesktopResizeEnabled] = createSignal(false)
	const [inputPaneHeight, setInputPaneHeight] = createSignal<number>()
	let messagesEl: HTMLDivElement | undefined
	let splitLayoutEl: HTMLDivElement | undefined
	let inputPaneEl: HTMLDivElement | undefined
	let historyEl: HTMLDivElement | undefined
	let modelPickerEl: HTMLDivElement | undefined
	let previousActiveSessionId = props.activeSessionId
	let defaultDesktopInputHeight = DEFAULT_DESKTOP_INPUT_HEIGHT
	let dragStartHeight = 0

	const hasTasks = () =>
		props.currentSessionTasks.length + props.otherSessionTasks.length > 0
	const runningTaskCount = () =>
		props.currentSessionTasks.filter((task) => task.status === 'running')
			.length +
		props.otherSessionTasks.filter((task) => task.status === 'running').length
	const isBusy = () => props.runState !== 'idle'
	const selectedProvider = () =>
		props.providers.find((provider) => provider.id === props.selectedProviderId)
	const modelPickerLabel = () => {
		const provider = selectedProvider()
		const selectedModel = provider?.models.find(
			(model) => model.id === props.selectedModelId,
		)
		return (
			[provider?.name, selectedModel?.name].filter(Boolean).join('/') ||
			t('noModel')
		)
	}

	function readStoredInputPaneHeight() {
		try {
			const raw = window.localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY)
			if (!raw) {
				return undefined
			}
			const value = Number(raw)
			return Number.isFinite(value) ? value : undefined
		} catch {
			return undefined
		}
	}

	function persistInputPaneHeight(height: number) {
		try {
			window.localStorage.setItem(
				INPUT_HEIGHT_STORAGE_KEY,
				String(Math.round(height)),
			)
		} catch {
			// Ignore storage errors, resize should still work.
		}
	}

	function getMaxInputPaneHeight() {
		const viewportMax = Math.floor(
			window.innerHeight * DESKTOP_INPUT_MAX_VIEWPORT_RATIO,
		)
		const splitHeight = splitLayoutEl?.getBoundingClientRect().height ?? 0
		if (splitHeight <= 0) {
			return Math.max(DESKTOP_INPUT_MIN_HEIGHT, viewportMax)
		}
		const messagesBound = Math.floor(
			splitHeight - DESKTOP_MESSAGES_MIN_HEIGHT - RESIZER_HITBOX_HEIGHT,
		)
		const maxHeight = Math.min(messagesBound, viewportMax)
		return Math.max(DESKTOP_INPUT_ABSOLUTE_MIN_HEIGHT, maxHeight)
	}

	function clampInputPaneHeight(height: number) {
		const maxHeight = getMaxInputPaneHeight()
		const minHeight = Math.min(DESKTOP_INPUT_MIN_HEIGHT, maxHeight)
		return Math.round(Math.min(Math.max(height, minHeight), maxHeight))
	}

	function applyInputPaneHeight(height: number, persist = false) {
		const next = clampInputPaneHeight(height)
		setInputPaneHeight(next)
		if (persist) {
			persistInputPaneHeight(next)
		}
		return next
	}

	function resetInputPaneHeight() {
		if (!desktopResizeEnabled()) {
			return
		}
		applyInputPaneHeight(defaultDesktopInputHeight, true)
	}

	function onInputPaneResizeStart() {
		if (!desktopResizeEnabled()) {
			return
		}
		dragStartHeight =
			inputPaneHeight() ?? clampInputPaneHeight(defaultDesktopInputHeight)
	}

	function onInputPaneResize(deltaY: number) {
		if (!desktopResizeEnabled()) {
			return
		}
		applyInputPaneHeight(dragStartHeight + deltaY)
	}

	function onInputPaneResizeEnd() {
		const height = inputPaneHeight()
		if (typeof height === 'number') {
			persistInputPaneHeight(height)
		}
	}

	function scrollMessagesToBottom(behavior: ScrollBehavior = 'smooth') {
		requestAnimationFrame(() => {
			if (!messagesEl) {
				return
			}
			messagesEl.scrollTo({
				top: messagesEl.scrollHeight,
				behavior,
			})
		})
	}

	createEffect(() => {
		const activeSessionId = props.activeSessionId
		props.timeline.length
		props.currentSessionTasks.length
		props.otherSessionTasks.length
		props.pendingMessages.length
		props.runState
		const behavior =
			previousActiveSessionId !== activeSessionId ? 'auto' : 'smooth'
		previousActiveSessionId = activeSessionId
		scrollMessagesToBottom(behavior)
	})

	createEffect(() => {
		if (!hasTasks() && tasksOpen()) {
			setTasksOpen(false)
		}
	})

	createEffect(() => {
		if (!historyOpen() && !modelPickerOpen()) {
			return
		}

		const onPointerDown = (event: PointerEvent) => {
			const target = event.target
			if (!(target instanceof Node)) {
				return
			}
			if (historyEl?.contains(target) || modelPickerEl?.contains(target)) {
				return
			}
			setHistoryOpen(false)
			setModelPickerOpen(false)
		}

		document.addEventListener('pointerdown', onPointerDown)
		onCleanup(() => document.removeEventListener('pointerdown', onPointerDown))
	})

	createEffect(() => {
		const mediaQuery = window.matchMedia(DESKTOP_RESIZE_MEDIA_QUERY)
		const update = () => setDesktopResizeEnabled(mediaQuery.matches)
		update()
		mediaQuery.addEventListener('change', update)
		onCleanup(() => mediaQuery.removeEventListener('change', update))
	})

	createEffect(() => {
		if (!desktopResizeEnabled() || !inputPaneEl) {
			return
		}
		defaultDesktopInputHeight =
			Math.round(inputPaneEl.getBoundingClientRect().height) ||
			DEFAULT_DESKTOP_INPUT_HEIGHT
		const storedHeight = readStoredInputPaneHeight()
		applyInputPaneHeight(storedHeight ?? defaultDesktopInputHeight)
	})

	createEffect(() => {
		if (desktopResizeEnabled()) {
			return
		}
		setInputPaneHeight(undefined)
	})

	createEffect(() => {
		if (!desktopResizeEnabled()) {
			return
		}
		const onResize = () => {
			const height = inputPaneHeight()
			if (typeof height !== 'number') {
				return
			}
			const clampedHeight = clampInputPaneHeight(height)
			if (clampedHeight !== height) {
				applyInputPaneHeight(clampedHeight, true)
			}
		}
		window.addEventListener('resize', onResize)
		onCleanup(() => window.removeEventListener('resize', onResize))
	})

	async function submit() {
		const text = input().trim()
		if (!text || !props.canSend) {
			return
		}
		setInput('')
		scrollMessagesToBottom('auto')
		await props.onSendMessage(text)
	}

	async function confirmDeleteSession() {
		const sessionId = sessionPendingDeleteId()
		if (!sessionId) {
			return
		}
		setSessionPendingDeleteId(undefined)
		await props.onDeleteSession(sessionId)
	}

	const requestDeleteMessage = props.onDeleteMessage
		? (messageId: string) => {
				const item = props.timeline.find(
					(i): i is ChatTimelineMessageItem =>
						i.kind === 'message' && i.message.id === messageId,
				)
				if (!item) return
				setPendingDeleteMessage(item)
			}
		: undefined

	const requestRegenerateMessage = props.onRegenerateMessage
		? (messageId: string) => {
				const item = props.timeline.find(
					(i): i is ChatTimelineMessageItem =>
						i.kind === 'message' && i.message.id === messageId,
				)
				if (!item) return
				setPendingRegenerateMessage(item)
			}
		: undefined

	const requestRecallMessage = props.onRecallMessage
		? (messageId: string) => {
				const item = props.timeline.find(
					(i): i is ChatTimelineMessageItem =>
						i.kind === 'message' && i.message.id === messageId,
				)
				if (!item) return
				setPendingRecallMessage(item)
			}
		: undefined

	async function doRecallMessage(
		item: ChatTimelineMessageItem,
		options?: { restoreFiles?: boolean },
	) {
		const text = (item.message.message.content ?? [])
			.filter((p) => p.type === 'text')
			.map((p) => (p as { type: 'text'; text: string }).text)
			.join('\n')
		setInput(text)
		await props.onRecallMessage?.(item.message.id, options)
	}

	async function confirmRecallMessage() {
		const item = pendingRecallMessage()
		if (!item) return
		setPendingRecallMessage(undefined)
		await doRecallMessage(item)
	}

	function confirmRegenerateMessage() {
		const item = pendingRegenerateMessage()
		if (!item) return
		setPendingRegenerateMessage(undefined)
		props.onRegenerateMessage?.(item.message.id)
	}

	function confirmDeleteMessage() {
		const item = pendingDeleteMessage()
		if (!item) return
		setPendingDeleteMessage(undefined)
		props.onDeleteMessage?.(item.message.id)
	}

	const deleteMessageConfirmText = () => {
		const item = pendingDeleteMessage()
		if (!item) return ''
		switch (item.message.message.role) {
			case 'user':
				return t('deleteUserMessageConfirm')
			case 'tool':
				return t('deleteToolMessageConfirm')
			default:
				return t('deleteAssistantMessageConfirm')
		}
	}

	const deleteMessageHasReversibleOps = () =>
		Boolean(pendingDeleteMessage()?.message.reversibleOps?.length)

	const recallHasReversibleOps = () => {
		const item = pendingRecallMessage()
		if (!item) return false
		let seenTarget = false
		for (const timelineItem of props.timeline) {
			if (timelineItem.kind !== 'message') {
				if (seenTarget) {
					break
				}
				continue
			}
			if (!seenTarget) {
				seenTarget = timelineItem.message.id === item.message.id
				continue
			}
			if (timelineItem.message.reversibleOps?.length) {
				return true
			}
		}
		return item.message.reversibleOps?.length ? true : false
	}

	async function confirmRecallAndRestoreMessage() {
		const item = pendingRecallMessage()
		if (!item) return
		setPendingRecallMessage(undefined)
		await doRecallMessage(item, { restoreFiles: true })
	}

	return (
		<div class="relative flex h-full overflow-hidden bg-[var(--background-primary)] text-[var(--text-normal)]">
			<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
				{/* Header */}
				<div class="relative flex shrink-0 items-center gap-2 border-b border-[var(--background-modifier-border)] px-3 py-3">
					<button
						type="button"
						onClick={() => {
							setHistoryOpen((value) => !value)
							setModelPickerOpen(false)
						}}
					>
						{t('history')}
					</button>
					<div class="min-w-0 flex-1 truncate text-sm font-semibold">
						{props.title || t('newChat')}
					</div>
					<Show when={hasTasks()}>
						<button
							class="mod-cta"
							type="button"
							onClick={() => setTasksOpen((value) => !value)}
						>
							{t('tasks')} ({runningTaskCount()})
						</button>
					</Show>
					<div class="relative" ref={modelPickerEl}>
						<button
							class="max-w-56 min-w-34 rounded-2 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] px-3 py-2 text-left text-sm hover:bg-[var(--background-modifier-hover)]"
							type="button"
							onClick={() => {
								setModelPickerOpen((value) => !value)
								setHistoryOpen(false)
							}}
						>
							<div class="truncate">{modelPickerLabel()}</div>
						</button>
						<Show when={modelPickerOpen()}>
							<div class="absolute right-0 top-12 z-10 w-72 rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] p-3 shadow-lg">
								<div class="mb-2 text-xs text-[var(--text-muted)]">
									{t('provider')}
								</div>
								<select
									class="w-full"
									value={props.selectedProviderId || ''}
									onChange={(event) =>
										props.onSelectProvider(event.currentTarget.value)
									}
								>
									<option value="">{t('noProvider')}</option>
									<For each={props.providers}>
										{(provider) => (
											<option value={provider.id}>{provider.name}</option>
										)}
									</For>
								</select>
								<div class="mb-2 mt-3 text-xs text-[var(--text-muted)]">
									{t('model')}
								</div>
								<select
									class="w-full"
									value={props.selectedModelId || ''}
									disabled={!selectedProvider()?.models.length || isBusy()}
									onChange={(event) => {
										props.onSelectModel(event.currentTarget.value)
										setModelPickerOpen(false)
									}}
								>
									<option value="">{t('noModel')}</option>
									<For each={selectedProvider()?.models || []}>
										{(model) => <option value={model.id}>{model.name}</option>}
									</For>
								</select>
							</div>
						</Show>
					</div>
					<Show when={historyOpen()}>
						<div
							ref={historyEl}
							class="absolute left-3 top-12 z-10 w-80 overflow-hidden rounded-4 border border-[var(--background-modifier-border)] bg-[var(--background-primary)] shadow-lg"
						>
							<div class="border-b border-[var(--background-modifier-border)] px-4 py-3">
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<div class="text-sm font-semibold text-[var(--text-normal)]">
											{t('history')}
										</div>
									</div>
									<button
										class="rounded-2 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] px-3 py-2 text-sm hover:bg-[var(--background-modifier-hover)]"
										type="button"
										onClick={() => {
											props.onNewSession()
											setHistoryOpen(false)
										}}
									>
										{t('newChat')}
									</button>
								</div>
							</div>
							<div class="max-h-80 overflow-auto p-3 scrollbar-default">
								<div class="flex flex-col gap-2">
									<For each={props.sessionHistory}>
										{(session) => (
											<SessionHistoryItem
												session={session}
												isActive={session.id === props.activeSessionId}
												onSelect={(sessionId) => {
													props.onSwitchSession(sessionId)
													setHistoryOpen(false)
												}}
												onDelete={(sessionId) => {
													setSessionPendingDeleteId(sessionId)
												}}
											/>
										)}
									</For>
								</div>
							</div>
						</div>
					</Show>
				</div>

				<div
					ref={splitLayoutEl}
					class="flex min-h-0 flex-1 flex-col overflow-hidden"
				>
					{/* Messages */}
					<div
						ref={messagesEl}
						class="min-h-0 flex-1 overflow-y-auto px-3 pb-3 scrollbar-default"
					>
						<Show
							when={
								props.timeline.length > 0 ||
								props.pendingMessages.length > 0 ||
								isBusy()
							}
							fallback={
								<div class="flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
									{t('empty')}
								</div>
							}
						>
							<div class="flex flex-col gap-3">
								<For each={props.timeline}>
									{(item) => (
										<Switch>
											<Match when={item.kind === 'fragment'}>
												<FragmentDivider
													item={item as ChatTimelineFragmentItem}
												/>
											</Match>
											<Match when={item.kind === 'message'}>
												<MessageCard
													item={item as ChatTimelineMessageItem}
													renderMarkdown={props.renderMarkdown}
													onDeleteMessage={requestDeleteMessage}
													onRegenerateMessage={requestRegenerateMessage}
													onRecallMessage={requestRecallMessage}
												/>
											</Match>
										</Switch>
									)}
								</For>
								<RunStateCard
									runState={props.runState}
									onStop={props.onStopActiveRun}
								/>
								<PendingList pendingMessages={props.pendingMessages} />
							</div>
						</Show>
					</div>

					<Show when={desktopResizeEnabled()}>
						<PaneResizer
							onResizeStart={onInputPaneResizeStart}
							onResize={onInputPaneResize}
							onResizeEnd={onInputPaneResizeEnd}
							onDblClick={resetInputPaneHeight}
						/>
					</Show>

					{/* Input */}
					<div
						ref={inputPaneEl}
						class={`chatbox-input-pane shrink-0 px-3 py-3 ${
							desktopResizeEnabled()
								? 'chatbox-input-pane--resizable'
								: 'border-t border-[var(--background-modifier-border)]'
						}`}
						style={
							desktopResizeEnabled() && typeof inputPaneHeight() === 'number'
								? { height: `${inputPaneHeight()}px` }
								: undefined
						}
					>
						<textarea
							class="chatbox-input w-full resize-none rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] text-sm outline-none"
							placeholder={t('inputPlaceholder')}
							value={input()}
							onInput={(event) => setInput(event.currentTarget.value)}
							onCompositionStart={() => setIsComposing(true)}
							onCompositionEnd={() => setIsComposing(false)}
							onKeyDown={(event) => {
								if (
									event.key === 'Enter' &&
									!event.shiftKey &&
									!isComposing() &&
									!event.isComposing &&
									event.keyCode !== 229
								) {
									event.preventDefault()
									void submit()
								}
							}}
						/>
						<div class="mt-3 flex items-center justify-between gap-3">
							<div class="flex flex-wrap items-center gap-2">
								<button
									class="chatbox-tag-button"
									type="button"
									disabled={!props.canCreateFragment}
									onClick={() => props.onNewFragment()}
								>
									{t('newFragment')}
								</button>
								<button
									class="chatbox-tag-button"
									type="button"
									disabled={!props.canCompress}
									onClick={() => void props.onCompressContext()}
								>
									{t('compressContext')}
								</button>
							</div>
							<button
								class="mod-cta"
								type="button"
								disabled={!input().trim()}
								onClick={() => void submit()}
							>
								{isBusy() ? t('queueSend') : t('send')}
							</button>
						</div>
					</div>
				</div>
			</div>

			{/* Tasks sidebar */}
			<Show when={tasksOpen()}>
				<TasksPanel
					currentSessionTasks={props.currentSessionTasks}
					otherSessionTasks={props.otherSessionTasks}
					onCancelTask={props.onCancelTask}
					onClose={() => setTasksOpen(false)}
				/>
			</Show>

			{/* Delete session dialog */}
			<Show when={sessionPendingDeleteId()}>
				<ConfirmDialog
					title={t('deleteSessionTitle')}
					message={t('deleteSessionMessage')}
					confirmLabel={t('confirmDelete')}
					onCancel={() => setSessionPendingDeleteId(undefined)}
					onConfirm={() => void confirmDeleteSession()}
				/>
			</Show>

			{/* Delete message dialog */}
			<Show when={pendingDeleteMessage()}>
				<ConfirmDialog
					title={t('deleteMessageTitle')}
					message={`${deleteMessageConfirmText()}${
						deleteMessageHasReversibleOps()
							? `\n\n${t('deleteToolMessageRestoreWarning')}`
							: ''
					}`}
					confirmLabel={t('confirmDelete')}
					onCancel={() => setPendingDeleteMessage(undefined)}
					onConfirm={confirmDeleteMessage}
				/>
			</Show>

			{/* Regenerate message dialog */}
			<Show when={pendingRegenerateMessage()}>
				<ConfirmDialog
					title={t('regenerateMessageTitle')}
					message={t('regenerateMessageConfirm')}
					confirmLabel={t('regenerateMessage')}
					onCancel={() => setPendingRegenerateMessage(undefined)}
					onConfirm={confirmRegenerateMessage}
				/>
			</Show>

			{/* Recall message dialog */}
			<Show when={pendingRecallMessage()}>
				<ConfirmDialog
					title={t('recallMessageTitle')}
					message={t('recallMessageConfirm')}
					confirmLabel={t('confirmRecall')}
					secondaryConfirmLabel={
						recallHasReversibleOps()
							? t('recallMessageRestoreConfirm')
							: undefined
					}
					onCancel={() => setPendingRecallMessage(undefined)}
					onConfirm={() => void confirmRecallMessage()}
					onSecondaryConfirm={() => void confirmRecallAndRestoreMessage()}
				/>
			</Show>
		</div>
	)
}

export default App

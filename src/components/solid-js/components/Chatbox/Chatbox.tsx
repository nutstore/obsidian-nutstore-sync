import { setIcon } from 'obsidian'
import { CHATBOX_DIALOG_CONTAINED_MIN_WIDTH } from '~/chat/modal-mount'
import {
	For,
	Match,
	Show,
	Switch,
	createEffect,
	createSignal,
	on,
	onCleanup,
} from 'solid-js'
import { createImageContextItem } from '~/chat/user-context'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ContextArea } from './components/ContextArea'
import { FragmentDivider } from './components/FragmentDivider'
import { MessageCard } from './components/MessageCard'
import { PaneResizer } from './components/PaneResizer'
import { PendingList } from './components/PendingList'
import { RunStateCard } from './components/RunStateCard'
import { SessionHistorySheet } from './components/SessionHistorySheet'
import { TasksPanel } from './components/TasksPanel'
import { t } from '../../i18n'
import type {
	ChatTimelineFragmentItem,
	ChatTimelineMessageItem,
	ChatboxProps,
} from './types'

function decodeURIComponentRepeatedly(value: string): string {
	let current = value.trim()
	for (let i = 0; i < 3; i += 1) {
		try {
			const decoded = decodeURIComponent(current)
			if (decoded === current) break
			current = decoded
		} catch {
			break
		}
	}
	return current
}

function normalizeDroppedPath(path: string): string | null {
	const decoded = decodeURIComponentRepeatedly(path)
		.replace(/^\[\[/, '')
		.replace(/\]\]$/, '')
	const withoutAlias = decoded.split('|')[0]?.trim() ?? ''
	const normalized = withoutAlias.replace(/^\/+/, '').replace(/\/+$/, '').trim()
	return normalized || null
}

function addDroppedPathPayload(payload: string, parsed: Set<string>) {
	const trimmedPayload = payload.trim()
	if (!trimmedPayload) return
	if (trimmedPayload.startsWith('{') || trimmedPayload.startsWith('[')) {
		try {
			addDroppedJsonPayload(JSON.parse(trimmedPayload), parsed)
			return
		} catch {
			// Fall through to plain text parsing.
		}
	}
	for (const line of trimmedPayload.split(/\r?\n/)) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('http')) {
			continue
		}
		if (trimmed.startsWith('obsidian://open?')) {
			try {
				const url = new URL(trimmed)
				const file = url.searchParams.get('file')
				if (file) {
					const normalized = normalizeDroppedPath(file)
					if (normalized) parsed.add(normalized)
				}
				continue
			} catch {
				// Fall through to plain path parsing.
			}
		}
		const normalized = normalizeDroppedPath(trimmed)
		if (normalized) parsed.add(normalized)
	}
}

function addDroppedJsonPayload(value: unknown, parsed: Set<string>) {
	if (typeof value === 'string') {
		const normalized = normalizeDroppedPath(value)
		if (normalized) parsed.add(normalized)
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) addDroppedJsonPayload(item, parsed)
		return
	}
	if (!value || typeof value !== 'object') return
	const record = value as Record<string, unknown>
	for (const key of ['path', 'file', 'files']) {
		if (key in record) addDroppedJsonPayload(record[key], parsed)
	}
}

function parseDroppedObsidianPaths(e: DragEvent): string[] {
	const parsed = new Set<string>()
	const dataTransfer = e.dataTransfer
	if (!dataTransfer) return []
	for (const type of Array.from(dataTransfer.types)) {
		if (type === 'Files') continue
		addDroppedPathPayload(dataTransfer.getData(type) ?? '', parsed)
	}
	return Array.from(parsed)
}

const DESKTOP_RESIZE_MEDIA_QUERY = '(pointer: fine) and (min-width: 1024px)'
const INPUT_HEIGHT_STORAGE_KEY = 'nutstore-sync.chatbox.desktop-input-height'
const DEFAULT_DESKTOP_INPUT_HEIGHT = 184
const DESKTOP_INPUT_MIN_HEIGHT = 120
const DESKTOP_INPUT_ABSOLUTE_MIN_HEIGHT = 72
const DESKTOP_MESSAGES_MIN_HEIGHT = 200
const RESIZER_HITBOX_HEIGHT = 10
const DESKTOP_INPUT_MAX_VIEWPORT_RATIO = 0.6

function Chatbox(props: ChatboxProps) {
	type RecallConfirmMode = 'only' | 'restore'
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
	const [recallConfirmMode, setRecallConfirmMode] =
		createSignal<RecallConfirmMode>()
	const [desktopResizeEnabled, setDesktopResizeEnabled] = createSignal(false)
	const [chatboxContainerWidth, setChatboxContainerWidth] = createSignal(0)
	const [inputPaneHeight, setInputPaneHeight] = createSignal<number>()
	const [stickToBottom, setStickToBottom] = createSignal(true)
	let chatboxRootEl: HTMLDivElement | undefined
	let messagesEl: HTMLDivElement | undefined
	let splitLayoutEl: HTMLDivElement | undefined
	let inputPaneEl: HTMLDivElement | undefined
	let modelPickerEl: HTMLDivElement | undefined
	let previousActiveSessionId: string | undefined
	let defaultDesktopInputHeight = DEFAULT_DESKTOP_INPUT_HEIGHT
	let dragStartHeight = 0

	function getViewDocument() {
		return (
			splitLayoutEl?.ownerDocument ??
			inputPaneEl?.ownerDocument ??
			messagesEl?.ownerDocument ??
			document
		)
	}

	function getViewWindow() {
		return getViewDocument().defaultView ?? window
	}

	const hasTasks = () =>
		props.currentSessionTasks.length + props.otherSessionTasks.length > 0
	const runningTaskCount = () =>
		props.currentSessionTasks.filter((task) => task.status === 'running')
			.length +
		props.otherSessionTasks.filter((task) => task.status === 'running').length
	const isBusy = () => props.runState !== 'idle'

	function isMessagesNearBottom(threshold = 48) {
		if (!messagesEl) {
			return true
		}
		const remaining =
			messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight
		return remaining <= threshold
	}

	const lastMessageFingerprint = () => {
		for (let index = props.timeline.length - 1; index >= 0; index -= 1) {
			const item = props.timeline[index]
			if (item?.kind !== 'message') {
				continue
			}
			const rawContent = item.message.message.content
			const contentArray = Array.isArray(rawContent)
				? (rawContent as Array<{ type: string; text?: string }>)
				: []
			const textLength = contentArray
				.filter((part) => part.type === 'text')
				.reduce((total, part) => total + (part.text?.length ?? 0), 0)
			const blockFingerprint = item.displayBlocks
				.map((block) => {
					if (block.kind === 'content') {
						return `c:${block.parts.length}`
					}
					if (block.kind === 'tool-call') {
						return `tc:${block.toolCall.toolCallId}:${block.toolMessage?.id ?? 'pending'}`
					}
					return `tr:${block.toolMessage.id}`
				})
				.join('|')
			return `${item.message.id}:${textLength}:${blockFingerprint}:${item.message.message.role}`
		}
		return 'empty'
	}

	const selectedProvider = () =>
		props.providers.find((provider) => provider.id === props.selectedProviderId)
	const dialogMountTarget = () => ({
		mountEl:
			chatboxContainerWidth() >= CHATBOX_DIALOG_CONTAINED_MIN_WIDTH &&
			chatboxRootEl
				? chatboxRootEl
				: (chatboxRootEl?.ownerDocument?.body ?? document.body),
		contained:
			chatboxContainerWidth() >= CHATBOX_DIALOG_CONTAINED_MIN_WIDTH &&
			!!chatboxRootEl,
	})
	const modelPickerLabel = () => {
		const provider = selectedProvider()
		const selectedModel = provider?.models.find(
			(model) => model.id === props.selectedModelId,
		)
		return (
			[provider?.name, selectedModel?.name].filter(Boolean).join('/') ||
			t('chatbox.ui.states.noModel')
		)
	}

	function readStoredInputPaneHeight() {
		try {
			const raw = getViewWindow().localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY)
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
			getViewWindow().localStorage.setItem(
				INPUT_HEIGHT_STORAGE_KEY,
				String(Math.round(height)),
			)
		} catch {
			// Ignore storage errors, resize should still work.
		}
	}

	function getMaxInputPaneHeight() {
		const viewportMax = Math.floor(
			getViewWindow().innerHeight * DESKTOP_INPUT_MAX_VIEWPORT_RATIO,
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
		getViewWindow().requestAnimationFrame(() => {
			if (!messagesEl) {
				return
			}
			messagesEl.scrollTo({
				top: messagesEl.scrollHeight,
				behavior,
			})
			setStickToBottom(true)
		})
	}

	createEffect(
		on(
			() => [
				props.activeSessionId,
				props.timeline.length,
				props.currentSessionTasks.length,
				props.otherSessionTasks.length,
				props.pendingMessages.length,
				props.runState,
			],
			([activeSessionId]) => {
				const behavior =
					previousActiveSessionId !== activeSessionId ? 'auto' : 'smooth'
				const shouldScroll =
					previousActiveSessionId !== activeSessionId || stickToBottom()
				previousActiveSessionId = activeSessionId?.toString()
				if (shouldScroll) {
					scrollMessagesToBottom(behavior)
				}
			},
		),
	)

	createEffect(
		on(
			() => [props.activeSessionId, lastMessageFingerprint()],
			([activeSessionId], previous) => {
				const previousActiveSessionId = previous?.[0]
				if (activeSessionId !== previousActiveSessionId || !stickToBottom()) {
					return
				}
				scrollMessagesToBottom('auto')
			},
		),
	)

	createEffect(() => {
		if (!messagesEl) {
			return
		}
		const onScroll = () => {
			setStickToBottom(isMessagesNearBottom())
		}
		onScroll()
		messagesEl.addEventListener('scroll', onScroll, { passive: true })
		onCleanup(() => messagesEl?.removeEventListener('scroll', onScroll))
	})

	createEffect(() => {
		if (!hasTasks() && tasksOpen()) {
			setTasksOpen(false)
		}
	})

	createEffect(
		on(
			() => props.activeSessionId,
			() => {
				setInput(props.pendingInputDraft)
			},
		),
	)

	createEffect(() => {
		if (!modelPickerOpen()) {
			return
		}

		const onPointerDown = (event: PointerEvent) => {
			const target = event.target
			if (!target || typeof target !== 'object' || !('nodeType' in target)) {
				return
			}
			const node = target as Node
			if (modelPickerEl?.contains(node)) {
				return
			}
			setModelPickerOpen(false)
		}

		const viewDoc = getViewDocument()
		viewDoc.addEventListener('pointerdown', onPointerDown)
		onCleanup(() => viewDoc.removeEventListener('pointerdown', onPointerDown))
	})

	createEffect(() => {
		const viewWindow = getViewWindow()
		const mediaQuery = viewWindow.matchMedia(DESKTOP_RESIZE_MEDIA_QUERY)
		const update = () => setDesktopResizeEnabled(mediaQuery.matches)
		update()
		if (typeof mediaQuery.addEventListener === 'function') {
			mediaQuery.addEventListener('change', update)
			onCleanup(() => mediaQuery.removeEventListener('change', update))
			return
		}
		mediaQuery.addListener(update)
		onCleanup(() => mediaQuery.removeListener(update))
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
		if (!chatboxRootEl) {
			return
		}
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry) {
				setChatboxContainerWidth(entry.contentRect.width)
			}
		})
		observer.observe(chatboxRootEl)
		onCleanup(() => observer.disconnect())
	})

	createEffect(() => {
		if (!desktopResizeEnabled()) {
			return
		}
		const viewWindow = getViewWindow()
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
		viewWindow.addEventListener('resize', onResize)
		onCleanup(() => viewWindow.removeEventListener('resize', onResize))
	})

	async function submit() {
		const text = input().trim()
		const hasPendingContext = props.pendingUserContext.length > 0
		if ((!text && !hasPendingContext) || !props.canSend) {
			return
		}
		const previousInput = input()
		setInput('')
		props.onUpdateInputDraft('')
		scrollMessagesToBottom('auto')
		try {
			const accepted = await props.onSendMessage(text)
			if (!accepted) {
				setInput(previousInput)
				props.onUpdateInputDraft(previousInput)
			}
		} catch (error) {
			setInput(previousInput)
			props.onUpdateInputDraft(previousInput)
			throw error
		}
	}

	async function confirmDeleteSession() {
		const sessionId = sessionPendingDeleteId()
		if (!sessionId) {
			return
		}
		setSessionPendingDeleteId(undefined)
		await props.onDeleteSession(sessionId)
	}

	function requestDeleteMessage(messageId: string) {
		if (!props.onDeleteMessage) return
		const item = props.timeline.find(
			(i): i is ChatTimelineMessageItem =>
				i.kind === 'message' && i.message.id === messageId,
		)
		if (!item) return
		setPendingDeleteMessage(item)
	}

	function requestRegenerateMessage(messageId: string) {
		if (!props.onRegenerateMessage) return
		const item = props.timeline.find(
			(i): i is ChatTimelineMessageItem =>
				i.kind === 'message' && i.message.id === messageId,
		)
		if (!item) return
		setPendingRegenerateMessage(item)
	}

	function requestRecallMessage(messageId: string) {
		if (!props.onRecallMessage) return
		const item = props.timeline.find(
			(i): i is ChatTimelineMessageItem =>
				i.kind === 'message' && i.message.id === messageId,
		)
		if (!item) return
		setPendingRecallMessage(item)
	}

	async function doRecallMessage(
		item: ChatTimelineMessageItem,
		options?: { restoreFiles?: boolean },
	) {
		const recalled = await props.onRecallMessage?.(item.message.id, options)
		if (recalled?.text !== undefined) {
			setInput(recalled.text)
			props.onUpdateInputDraft(recalled.text)
			return
		}
		const rawContent = item.message.message.content
		const fallbackText = (
			Array.isArray(rawContent)
				? (rawContent as Array<{ type: string; text?: string }>)
				: []
		)
			.filter((p) => p.type === 'text')
			.map((p) => p.text ?? '')
			.join('\n')
		setInput(fallbackText)
		props.onUpdateInputDraft(fallbackText)
	}

	async function confirmRecallMessage() {
		const item = pendingRecallMessage()
		if (!item) return
		setRecallConfirmMode(undefined)
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
				return t('chatbox.ui.dialogs.deleteMessage.userConfirm')
			case 'tool':
				return t('chatbox.ui.dialogs.deleteMessage.toolConfirm')
			default:
				return t('chatbox.ui.dialogs.deleteMessage.assistantConfirm')
		}
	}

	const deleteMessageHasReversibleOps = () =>
		Boolean(pendingDeleteMessage()?.message.reversibleOps?.length)

	const recallHasReversibleOps = () => {
		const item = pendingRecallMessage()
		if (!item) return false
		if (props.onRecallHasReversibleOps) {
			return props.onRecallHasReversibleOps(item.message.id)
		}
		return Boolean(item.message.reversibleOps?.length)
	}

	async function confirmRecallAndRestoreMessage() {
		const item = pendingRecallMessage()
		if (!item) return
		setRecallConfirmMode(undefined)
		setPendingRecallMessage(undefined)
		await doRecallMessage(item, { restoreFiles: true })
	}

	const recallSecondConfirmTitle = () => {
		switch (recallConfirmMode()) {
			case 'restore':
				return t('chatbox.ui.dialogs.recall.restoreSecondTitle')
			case 'only':
				return t('chatbox.ui.dialogs.recall.onlySecondTitle')
			default:
				return undefined
		}
	}

	const recallSecondConfirmMessage = () => {
		switch (recallConfirmMode()) {
			case 'restore':
				return t('chatbox.ui.dialogs.recall.restoreSecondMessage')
			case 'only':
				return t('chatbox.ui.dialogs.recall.onlySecondMessage')
			default:
				return undefined
		}
	}

	const recallSecondConfirmLabel = () => {
		switch (recallConfirmMode()) {
			case 'restore':
				return t('chatbox.ui.dialogs.recall.restoreConfirm')
			case 'only':
				return t('chatbox.ui.dialogs.recall.onlyConfirm')
			default:
				return undefined
		}
	}

	return (
		<div
			ref={chatboxRootEl}
			class="relative flex h-full overflow-hidden bg-[var(--background-primary)] text-[var(--text-normal)]"
		>
			<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
				{/* Header */}
				<div class="relative flex shrink-0 items-center gap-2 border-b border-[var(--background-modifier-border)] px-3 py-3">
					<div
						class="flex justify-center items-center hover:text-[--interactive-accent] hover:cursor-pointer transition-colors"
						onClick={() => {
							setHistoryOpen((value) => !value)
							setModelPickerOpen(false)
						}}
						ref={(el) => {
							setIcon(el, 'history')
						}}
					/>
					<div class="min-w-0 flex-1 truncate text-sm font-semibold">
						{props.title || t('chatbox.newChat')}
					</div>
					<Show when={hasTasks()}>
						<button
							class="mod-cta"
							type="button"
							onClick={() => setTasksOpen((value) => !value)}
						>
							{t('chatbox.ui.labels.tasks')} ({runningTaskCount()})
						</button>
					</Show>
					<div class="relative" ref={modelPickerEl}>
						<button
							class="max-w-56 min-w-34 text-sm"
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
									{t('chatbox.ui.labels.provider')}
								</div>
								<select
									class="w-full"
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
								<div class="mb-2 mt-3 text-xs text-[var(--text-muted)]">
									{t('chatbox.ui.labels.model')}
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
									<option value="">{t('chatbox.ui.states.noModel')}</option>
									<For each={selectedProvider()?.models || []}>
										{(model) => <option value={model.id}>{model.name}</option>}
									</For>
								</select>
							</div>
						</Show>
					</div>
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
									{t('chatbox.ui.states.empty')}
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
						onDragOver={(e) => {
							e.preventDefault()
							if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
						}}
						onDrop={(e) => {
							e.preventDefault()
							for (const path of parseDroppedObsidianPaths(e)) {
								props.onDropContextItem(path)
							}
						}}
					>
						<Show when={props.pendingUserContext.length > 0}>
							<ContextArea
								items={props.pendingUserContext}
								onRemove={props.onRemoveUserContext}
							/>
						</Show>
						<textarea
							class="chatbox-input w-full resize-none rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] text-sm outline-none"
							placeholder={t('chatbox.ui.placeholders.input')}
							value={input()}
							onInput={(event) => {
								const nextInput = event.currentTarget.value
								setInput(nextInput)
								props.onUpdateInputDraft(nextInput)
							}}
							onPaste={(event) => {
								const addUserContext = props.onAddUserContext
								const imageFiles = Array.from(event.clipboardData?.items ?? [])
									.filter(
										(item) =>
											item.kind === 'file' && item.type.startsWith('image/'),
									)
									.map((item) => item.getAsFile())
									.filter((file): file is File => !!file)
								if (!imageFiles.length) return
								event.preventDefault()
								void Promise.all(
									imageFiles.map(async (file) => {
										addUserContext(
											await createImageContextItem(file, {
												mimeType: file.type || 'image/png',
												name: file.name,
												size: file.size,
											}),
										)
									}),
								)
							}}
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
									{t('chatbox.ui.actions.newFragment')}
								</button>
								<button
									class="chatbox-tag-button"
									type="button"
									disabled={!props.canCompress}
									onClick={() => void props.onCompressContext()}
								>
									{t('chatbox.ui.actions.compressContext')}
								</button>
							</div>
							<button
								class="mod-cta"
								type="button"
								disabled={!input().trim() && !props.pendingUserContext.length}
								onClick={() => void submit()}
							>
								{isBusy()
									? t('chatbox.ui.actions.queueSend')
									: t('chatbox.ui.actions.send')}
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

			{/* History bottom sheet */}
			<SessionHistorySheet
				open={historyOpen()}
				sessions={props.sessionHistory}
				activeSessionId={props.activeSessionId}
				otherSessionTasks={props.otherSessionTasks}
				otherBusySessionIds={props.otherBusySessionIds}
				mountEl={dialogMountTarget().mountEl}
				contained={dialogMountTarget().contained}
				onClose={() => setHistoryOpen(false)}
				onNewSession={props.onNewSession}
				onSwitchSession={props.onSwitchSession}
				onExportSession={(sessionId) => void props.onExportSession(sessionId)}
				onDelete={(sessionId) => setSessionPendingDeleteId(sessionId)}
			/>

			{/* Delete session dialog */}
			<Show when={sessionPendingDeleteId()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.deleteSession.title')}
					message={t('chatbox.ui.dialogs.deleteSession.message')}
					confirmLabel={t('chatbox.ui.dialogs.deleteSession.confirm')}
					mountEl={dialogMountTarget().mountEl}
					contained={dialogMountTarget().contained}
					onCancel={() => setSessionPendingDeleteId(undefined)}
					onConfirm={() => void confirmDeleteSession()}
				/>
			</Show>

			{/* Delete message dialog */}
			<Show when={pendingDeleteMessage()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.deleteMessage.title')}
					message={`${deleteMessageConfirmText()}${
						deleteMessageHasReversibleOps()
							? `\n\n${t('chatbox.ui.dialogs.deleteMessage.toolRestoreWarning')}`
							: ''
					}`}
					confirmLabel={t('chatbox.ui.dialogs.deleteMessage.confirm')}
					mountEl={dialogMountTarget().mountEl}
					contained={dialogMountTarget().contained}
					onCancel={() => setPendingDeleteMessage(undefined)}
					onConfirm={confirmDeleteMessage}
				/>
			</Show>

			{/* Regenerate message dialog */}
			<Show when={pendingRegenerateMessage()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.regenerate.title')}
					message={t('chatbox.ui.dialogs.regenerate.message')}
					confirmLabel={t('chatbox.ui.dialogs.regenerate.confirm')}
					mountEl={dialogMountTarget().mountEl}
					contained={dialogMountTarget().contained}
					onCancel={() => setPendingRegenerateMessage(undefined)}
					onConfirm={confirmRegenerateMessage}
				/>
			</Show>

			{/* Recall message dialog */}
			<Show when={pendingRecallMessage() && !recallConfirmMode()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.recall.title')}
					message={t('chatbox.ui.dialogs.recall.message')}
					confirmLabel={t('chatbox.ui.dialogs.recall.onlyConfirm')}
					secondaryConfirmLabel={
						recallHasReversibleOps()
							? t('chatbox.ui.dialogs.recall.restoreConfirm')
							: undefined
					}
					mountEl={dialogMountTarget().mountEl}
					contained={dialogMountTarget().contained}
					onCancel={() => {
						setRecallConfirmMode(undefined)
						setPendingRecallMessage(undefined)
					}}
					onConfirm={() => setRecallConfirmMode('only')}
					onSecondaryConfirm={() => setRecallConfirmMode('restore')}
				/>
			</Show>

			<Show when={pendingRecallMessage() && recallConfirmMode()}>
				<ConfirmDialog
					title={recallSecondConfirmTitle()}
					message={recallSecondConfirmMessage()}
					confirmLabel={recallSecondConfirmLabel()}
					mountEl={dialogMountTarget().mountEl}
					contained={dialogMountTarget().contained}
					onCancel={() => setRecallConfirmMode(undefined)}
					onConfirm={() =>
						recallConfirmMode() === 'restore'
							? void confirmRecallAndRestoreMessage()
							: void confirmRecallMessage()
					}
				/>
			</Show>
		</div>
	)
}

export default Chatbox

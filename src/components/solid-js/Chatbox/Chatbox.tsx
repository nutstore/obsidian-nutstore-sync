import { sample } from 'es-toolkit'
import { Notice } from 'obsidian'
import {
	Show,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	on,
	onCleanup,
	onMount,
	type JSX,
	untrack,
} from 'solid-js'
import {
	createFileContextItem,
	createImageContextItem,
	createPendingContextItem,
} from '~/ai/chat/context/user-context'
import { resolveUsedContextTokens } from '~/ai/chat/domain'
import { resolveChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import type { ChatTimelineMessageItem, ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '../i18n'
import { observeBottomFollow } from './bottom-follow'
import {
	ConfirmDialog,
	type ConfirmDialogView,
} from './components/ConfirmDialog'
import { ContextArea } from './components/ContextArea'
import { ContextRing } from './components/ContextRing'
import { McpServersDialog } from './components/McpServersDialog'
import { TurnTimeline } from './components/TurnTimeline'
import { MessageCard } from './components/MessageCard'
import { ModelPickerDialog } from './components/ModelPickerDialog'
import { PaneResizer } from './components/PaneResizer'
import { PendingList } from './components/PendingList'
import { ProviderSetup } from './components/ProviderSetup'
import { RunStateCard } from './components/RunStateCard'
import { SessionHistorySheet } from './components/SessionHistorySheet'
import { SubagentTimelineDialog } from './components/SubagentTimelineDialog'
import { decideDropRoute, hasDragItems } from './drop-utils'
import { ChatComposer } from './components/ChatComposer'
import {
	DEFAULT_VISIBLE_TURNS,
	VISIBLE_TURN_PAGE,
	sliceTimelineByTurns,
} from './timeline-window'

const INPUT_HEIGHT_STORAGE_KEY = 'nutstore-sync.chatbox.input-height'
const LEGACY_INPUT_HEIGHT_STORAGE_KEY =
	'nutstore-sync.chatbox.desktop-input-height'
const RESIZER_HITBOX_HEIGHT = 10
const COMPACT_LAYOUT_MAX_WIDTH = 768
const SM_MAX_WIDTH = 640
const PICKER_ACCEPT = 'image/*,.txt,.md,.markdown'
const TEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'markdown'])

/**
 * Composer pane geometry per layout mode. Compact keeps the composer and a few
 * message lines inside a phone-sized viewport; the pairs read top to bottom.
 */
const INPUT_PANE_LAYOUT = {
	regular: {
		defaultHeight: 184,
		minHeight: 128,
		absoluteMinHeight: 72,
		messagesMinHeight: 200,
		maxViewportRatio: 0.6,
	},
	compact: {
		defaultHeight: 144,
		minHeight: 104,
		absoluteMinHeight: 64,
		messagesMinHeight: 120,
		maxViewportRatio: 0.45,
	},
} as const

function getFileExtension(filename: string): string {
	const extension = filename.split('.').pop()?.trim().toLowerCase()
	return extension || ''
}

function isSupportedTextFile(file: File): boolean {
	const extension = getFileExtension(file.name)
	if (TEXT_FILE_EXTENSIONS.has(extension)) {
		return true
	}
	const mimeType = file.type.toLowerCase()
	return mimeType === 'text/plain' || mimeType === 'text/markdown'
}

function isSupportedPickedFile(file: File): boolean {
	return file.type.startsWith('image/') || isSupportedTextFile(file)
}

/**
 * Keeps message growth observable after Markdown and media finish rendering.
 * Data changes alone cannot detect those later layout changes.
 */
function MessageScrollContent(props: {
	class: string
	onResize: () => void
	children: JSX.Element
}) {
	let el!: HTMLDivElement

	onMount(() => {
		const ResizeObserverConstructor =
			el.ownerDocument.defaultView?.ResizeObserver
		if (!ResizeObserverConstructor) return
		const observer = new ResizeObserverConstructor(() =>
			untrack(() => props.onResize()),
		)
		observer.observe(el)
		onCleanup(() => observer.disconnect())
	})

	return (
		<div ref={el} class={props.class}>
			{props.children}
		</div>
	)
}

/** Which recall confirmation is armed; the second click performs the recall. */
type RecallArmedMode = 'only' | 'restore'

/** One confirmation slot: destructive prompts never stack. */
type PendingConfirm =
	| { kind: 'delete-session'; sessionId: string }
	| { kind: 'compress-context' }
	| {
			kind: 'message'
			action: 'delete' | 'regenerate' | 'recall'
			item: ChatTimelineMessageItem
	  }

function Chatbox(props: ChatboxProps) {
	const sendLabelId = createUniqueId()
	let workspaceHostEl: HTMLDivElement | undefined
	const [input, setInput] = createSignal('')
	const isInputEmpty = createMemo(() => input().length === 0)
	// Pick once per empty-input period, including after sending or clearing a draft.
	const inputPlaceholder = createMemo(() => {
		if (!isInputEmpty()) return ''
		return t(
			sample([
				'chatbox.ui.placeholders.suggestions.ask',
				'chatbox.ui.placeholders.suggestions.idea',
				'chatbox.ui.placeholders.suggestions.summary',
				'chatbox.ui.placeholders.suggestions.outline',
				'chatbox.ui.placeholders.suggestions.explain',
				'chatbox.ui.placeholders.suggestions.polish',
				'chatbox.ui.placeholders.suggestions.steps',
				'chatbox.ui.placeholders.suggestions.connections',
			] as const),
		)
	})
	const [historyOpen, setHistoryOpen] = createSignal(false)
	const [selectedAgentId, setSelectedAgentId] = createSignal<string>()
	const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
	const [pendingConfirm, setPendingConfirm] = createSignal<PendingConfirm>()
	const [recallArmedMode, setRecallArmedMode] = createSignal<RecallArmedMode>()
	const [chatboxContainerWidth, setChatboxContainerWidth] = createSignal(0)
	const [inputPaneHeight, setInputPaneHeight] = createSignal<number>()
	const [stickToBottom, setStickToBottom] = createSignal(true)
	const [isFileDragActive, setIsFileDragActive] = createSignal(false)
	const [now, setNow] = createSignal(Date.now())
	const [visibleTurns, setVisibleTurns] = createSignal(DEFAULT_VISIBLE_TURNS)
	let chatboxRootEl: HTMLDivElement | undefined
	let messagesEl: HTMLDivElement | undefined
	let splitLayoutEl: HTMLDivElement | undefined
	let inputPaneEl: HTMLDivElement | undefined
	let fileInputEl: HTMLInputElement | undefined
	let composerCardEl: HTMLDivElement | undefined
	let inputEditorEl: HTMLDivElement | undefined
	let previousActiveSessionId: string | undefined
	let previousMessagesScrollTop = 0
	let defaultInputHeight: number = INPUT_PANE_LAYOUT.regular.defaultHeight
	let dragStartHeight = 0

	// One tick per second only while some duration can still grow. The memo keeps
	// streaming updates from restarting the timer on every chunk.
	const hasLiveDuration = createMemo(
		() =>
			Object.values(props.agentsById).some(
				(agent) =>
					agent.status === 'queued' ||
					agent.status === 'running' ||
					agent.status === 'idle',
			) ||
			props.timeline.some((item) =>
				item.displayBlocks.some(
					(block) =>
						block.kind === 'tool-call' &&
						!!block.timing &&
						block.timing.finishedAt === undefined,
				),
			),
	)

	createEffect(() => {
		if (!hasLiveDuration()) return
		const viewWindow = getViewWindow()
		setNow(Date.now())
		const interval = viewWindow.setInterval(() => setNow(Date.now()), 1000)
		onCleanup(() => viewWindow.clearInterval(interval))
	})

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

	function isCompactLayout() {
		const width = chatboxContainerWidth() || chatboxRootEl?.clientWidth || 0
		if (width > 0) {
			return width <= COMPACT_LAYOUT_MAX_WIDTH
		}
		return getViewWindow().innerWidth <= COMPACT_LAYOUT_MAX_WIDTH
	}

	function isSmallChatbox() {
		const width = chatboxContainerWidth() || chatboxRootEl?.clientWidth || 0
		if (width > 0) {
			return width < SM_MAX_WIDTH
		}
		return getViewWindow().innerWidth < SM_MAX_WIDTH
	}

	const inputPaneLayout = createMemo(
		() => INPUT_PANE_LAYOUT[isCompactLayout() ? 'compact' : 'regular'],
	)

	function dismissInputFocus() {
		const activeElement = getViewDocument().activeElement
		if (activeElement instanceof HTMLElement) {
			activeElement.blur()
		}
		inputEditorEl?.blur()
	}

	function openCompressContextConfirm() {
		dismissInputFocus()
		getViewWindow().requestAnimationFrame(() => {
			setPendingConfirm({ kind: 'compress-context' })
		})
	}

	const visibleTimeline = createMemo(() =>
		sliceTimelineByTurns(props.timeline, visibleTurns()),
	)
	const hasEarlierTurns = createMemo(
		() => visibleTimeline().length < props.timeline.length,
	)
	const isBusy = () => props.runState !== 'idle'
	const streamingMessageId = createMemo(() => {
		if (!isBusy()) return undefined
		for (let index = props.timeline.length - 1; index >= 0; index -= 1) {
			const message = props.timeline[index]?.message
			if (message?.role === 'assistant') return message.id
		}
		return undefined
	})

	const contextUsedTokens = createMemo(() =>
		resolveUsedContextTokens(props.usage),
	)
	const contextUsageRatio = () => {
		const total = props.contextWindow
		if (!total || total <= 0) return 0
		const used = contextUsedTokens()
		if (used <= 0) return 0
		return Math.min(1, Math.max(0, used / total))
	}
	const contextUsageTitle = () => {
		const total = props.contextWindow
		if (!total) return undefined
		const usedPct = Math.round(contextUsageRatio() * 100)
		const used = contextUsedTokens()
		return t('chatbox.ui.tooltips.contextUsage', {
			used: usedPct,
			total,
			usedTokens: used,
		})
	}

	function isMessagesNearBottom(threshold = 48) {
		if (!messagesEl) {
			return true
		}
		const remaining =
			messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight
		return remaining <= threshold
	}

	const selectedProvider = createMemo(() =>
		props.providers.find(
			(provider) => provider.id === props.selectedProviderId,
		),
	)
	const selectedModel = createMemo(() =>
		selectedProvider()?.models.find(
			(model) => model.id === props.selectedModelId,
		),
	)
	const providerReady = createMemo(
		() => props.providerSetup === undefined && !props.loading,
	)
	// One target per width change: every dialog shares it, so neither the
	// allocation nor the layout read repeats per dialog render.
	const dialogMountTarget = createMemo(() =>
		resolveChatModalMountTarget(chatboxRootEl, {
			width: chatboxContainerWidth(),
		}),
	)
	/** Stable lookup so streaming updates do not hand rows a new prop every chunk. */
	const getSubagent = (agentId: string) => props.agentsById[agentId]
	const selectedAgent = () => {
		const agentId = selectedAgentId()
		return agentId ? getSubagent(agentId) : undefined
	}
	const modelPickerLabel = () =>
		[selectedProvider()?.name, selectedModel()?.name]
			.filter(Boolean)
			.join(' · ') || t('chatbox.ui.states.noModel')
	const compactModelPickerLabel = () =>
		selectedModel()?.name ||
		selectedProvider()?.name ||
		t('chatbox.ui.states.noModel')
	function readStoredInputPaneHeight() {
		try {
			const raw = getViewWindow().localStorage.getItem(INPUT_HEIGHT_STORAGE_KEY)
			if (raw) {
				const value = Number(raw)
				return Number.isFinite(value) ? value : undefined
			}
			const legacyRaw = getViewWindow().localStorage.getItem(
				LEGACY_INPUT_HEIGHT_STORAGE_KEY,
			)
			if (!legacyRaw) {
				return undefined
			}
			const value = Number(legacyRaw)
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

	function getInputPaneChromeHeight() {
		if (!inputPaneEl || !inputEditorEl) {
			return 0
		}
		const paneHeight = inputPaneEl.getBoundingClientRect().height
		const textareaHeight = inputEditorEl.getBoundingClientRect().height
		return Math.max(0, Math.round(paneHeight - textareaHeight))
	}

	function getMaxInputPaneHeight() {
		const layout = inputPaneLayout()
		const viewportMax = Math.floor(
			getViewWindow().innerHeight * layout.maxViewportRatio,
		)
		const splitHeight = splitLayoutEl?.getBoundingClientRect().height ?? 0
		if (splitHeight <= 0) {
			return Math.max(layout.minHeight, viewportMax)
		}
		const messagesBound = Math.floor(
			splitHeight - layout.messagesMinHeight - RESIZER_HITBOX_HEIGHT,
		)
		const maxHeight = Math.min(messagesBound, viewportMax)
		return Math.max(layout.absoluteMinHeight, maxHeight)
	}

	function clampInputPaneHeight(height: number) {
		const maxHeight = getMaxInputPaneHeight()
		const minHeight = Math.min(inputPaneLayout().minHeight, maxHeight)
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

	/** Window and pane resizes shrink the available space; keep the height legal. */
	function reapplyInputPaneHeight() {
		const height = inputPaneHeight()
		if (typeof height !== 'number') {
			return
		}
		const clampedHeight = clampInputPaneHeight(height)
		if (clampedHeight !== height) {
			applyInputPaneHeight(clampedHeight, true)
		}
	}

	function getTextareaHeightStyle() {
		const paneHeight = inputPaneHeight()
		if (typeof paneHeight !== 'number') {
			return undefined
		}
		const chromeHeight = getInputPaneChromeHeight()
		return `${Math.max(inputPaneLayout().absoluteMinHeight, paneHeight - chromeHeight)}px`
	}

	function resetInputPaneHeight() {
		applyInputPaneHeight(defaultInputHeight, true)
	}

	function onInputPaneResizeStart() {
		dragStartHeight =
			inputPaneHeight() ?? clampInputPaneHeight(defaultInputHeight)
	}

	function onInputPaneResize(deltaY: number) {
		applyInputPaneHeight(dragStartHeight + deltaY)
	}

	function onInputPaneResizeEnd() {
		const height = inputPaneHeight()
		if (typeof height === 'number') {
			persistInputPaneHeight(height)
		}
	}

	function scrollMessagesToBottom(force = false) {
		if (force) setStickToBottom(true)
		getViewWindow().requestAnimationFrame(() => {
			if (!messagesEl || (!force && !untrack(() => stickToBottom()))) {
				return
			}
			messagesEl.scrollTop = messagesEl.scrollHeight
			setStickToBottom(true)
		})
	}

	function onMessageContentResize() {
		if (stickToBottom()) scrollMessagesToBottom()
	}

	function loadEarlierTurns() {
		const element = messagesEl
		const previousHeight = element?.scrollHeight ?? 0
		const previousScrollTop = element?.scrollTop ?? 0
		setVisibleTurns((value) => value + VISIBLE_TURN_PAGE)
		if (!element) return
		getViewWindow().requestAnimationFrame(() => {
			if (!messagesEl) return
			messagesEl.scrollTop =
				messagesEl.scrollHeight - previousHeight + previousScrollTop
		})
	}

	async function addPickedFile(file: File) {
		if (!isSupportedPickedFile(file)) {
			new Notice(
				t('chatbox.errors.unsupportedAttachmentType', { name: file.name }),
			)
			return
		}
		if (file.type.startsWith('image/')) {
			const pending = createPendingContextItem('image', file.name)
			props.onAddUserContext(pending)
			try {
				const item = await createImageContextItem(file, {
					mimeType: file.type || 'image/png',
					name: file.name,
					size: file.size,
				})
				props.onResolvePendingContextItem(pending.id, item)
			} catch (error) {
				props.onResolvePendingContextItem(pending.id, null)
				throw error
			}
			return
		}
		props.onAddUserContext(
			createFileContextItem(file, {
				mimeType: file.type || 'text/plain',
				filename: file.name,
				size: file.size,
			}),
		)
	}

	async function addPickedFiles(files: File[]) {
		await Promise.all(files.map((file) => addPickedFile(file)))
	}

	function openFilePicker() {
		fileInputEl?.click()
	}

	function resetFileDragState() {
		setIsFileDragActive(false)
	}

	function handleRootDragOver(event: DragEvent) {
		if (!hasDragItems(event)) {
			return
		}
		event.preventDefault()
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'copy'
		}
		setIsFileDragActive(true)
	}

	function handleRootDragLeave(event: DragEvent) {
		if (!hasDragItems(event)) {
			return
		}
		if (!chatboxRootEl) {
			return
		}
		const rect = chatboxRootEl.getBoundingClientRect()
		const x = event.clientX
		const y = event.clientY
		if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) {
			return
		}
		event.preventDefault()
		setIsFileDragActive(false)
	}

	async function handleRootDrop(event: DragEvent) {
		if (!hasDragItems(event)) {
			return
		}
		event.preventDefault()
		event.stopPropagation()
		const { paths, files } = decideDropRoute(event)
		resetFileDragState()
		if (paths.length > 0) {
			for (const path of paths) {
				await props.onDropContextItem(path)
			}
			return
		}
		if (files.length > 0) {
			await addPickedFiles(files)
		}
	}

	onMount(() => {
		props.onModalHostChange?.(chatboxRootEl)
		onCleanup(() => props.onModalHostChange?.(undefined))
	})

	createEffect(() => {
		if (!providerReady()) return
		// The host owns the workspace panel's lifetime. Props are replaced with
		// fresh callbacks on every view update (e.g. each pointerdown), so the
		// callback must not be tracked or the panel is rebuilt under the cursor.
		const notify = untrack(() => props.onWorkspaceHostChange)
		notify?.(workspaceHostEl)
		onCleanup(() => notify?.(undefined))
	})

	createEffect(
		on(
			() => [
				props.activeSessionId,
				props.timeline.length,
				props.pending.length,
				props.runState,
			],
			([activeSessionId]) => {
				const sessionChanged = previousActiveSessionId !== activeSessionId
				previousActiveSessionId = activeSessionId?.toString()
				if (sessionChanged) setVisibleTurns(DEFAULT_VISIBLE_TURNS)
				if (sessionChanged || stickToBottom()) {
					scrollMessagesToBottom(sessionChanged)
				}
			},
		),
	)

	// Any timeline update can grow the last message; follow it while pinned.
	createEffect(
		on(
			() => [props.activeSessionId, props.timeline] as const,
			([activeSessionId], previous) => {
				if (activeSessionId !== previous?.[0] || !stickToBottom()) return
				scrollMessagesToBottom()
			},
		),
	)

	createEffect(() => {
		if (!messagesEl) {
			return
		}
		const element = messagesEl
		previousMessagesScrollTop = element.scrollTop
		setStickToBottom(isMessagesNearBottom())
		const onScroll = () => {
			const scrollTop = element.scrollTop
			setStickToBottom(
				observeBottomFollow({
					following: stickToBottom(),
					previousScrollTop: previousMessagesScrollTop,
					currentScrollTop: scrollTop,
					distanceFromBottom:
						element.scrollHeight - scrollTop - element.clientHeight,
				}),
			)
			previousMessagesScrollTop = scrollTop
		}
		element.addEventListener('scroll', onScroll, { passive: true })
		onCleanup(() => element.removeEventListener('scroll', onScroll))
	})

	createEffect(() => {
		const id = selectedAgentId()
		if (id && !props.agentsById[id]) setSelectedAgentId(undefined)
	})

	createEffect(
		on(
			() => [props.activeSessionId, props.draft.text] as const,
			() => {
				setInput(props.draft.text)
			},
		),
	)

	createEffect(() => {
		if (!providerReady() || !inputEditorEl) {
			return
		}
		defaultInputHeight =
			Math.round(inputPaneEl?.getBoundingClientRect().height ?? 0) ||
			inputPaneLayout().defaultHeight
		const storedHeight = readStoredInputPaneHeight()
		applyInputPaneHeight(storedHeight ?? defaultInputHeight)
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
		if (!chatboxRootEl) {
			return
		}
		const root = chatboxRootEl
		const onDrop = (event: DragEvent) => {
			void handleRootDrop(event)
		}
		root.addEventListener('dragenter', handleRootDragOver, true)
		root.addEventListener('dragover', handleRootDragOver, true)
		root.addEventListener('dragleave', handleRootDragLeave, true)
		root.addEventListener('drop', onDrop, true)
		onCleanup(() => {
			root.removeEventListener('dragenter', handleRootDragOver, true)
			root.removeEventListener('dragover', handleRootDragOver, true)
			root.removeEventListener('dragleave', handleRootDragLeave, true)
			root.removeEventListener('drop', onDrop, true)
		})
	})

	// The capture callback is recreated on every host update; the listener stays
	// put and reads the current prop when the pointer lands.
	const onPointerDownCapture = () => props.onCaptureActiveContext?.()

	createEffect(() => {
		if (!chatboxRootEl) {
			return
		}
		const root = chatboxRootEl
		root.addEventListener('pointerdown', onPointerDownCapture, true)
		onCleanup(() => {
			root.removeEventListener('pointerdown', onPointerDownCapture, true)
		})
	})

	createEffect(() => {
		const viewWindow = getViewWindow()
		viewWindow.addEventListener('resize', reapplyInputPaneHeight)
		onCleanup(() =>
			viewWindow.removeEventListener('resize', reapplyInputPaneHeight),
		)
	})

	createEffect(() => {
		if (!providerReady() || !inputPaneEl || !inputEditorEl) {
			return
		}
		const observer = new ResizeObserver(reapplyInputPaneHeight)
		observer.observe(inputPaneEl)
		observer.observe(inputEditorEl)
		onCleanup(() => observer.disconnect())
	})

	async function submit() {
		const text = input().trim()
		const hasPendingContext =
			props.draft.userContext.length > 0 || props.activeContextItems.length > 0
		if ((!text && !hasPendingContext) || !props.canSend) {
			return
		}
		const previousInput = input()
		setInput('')
		props.onUpdateInputDraft('')
		scrollMessagesToBottom(true)
		try {
			const accepted = await props.onSendMessage(text, props.activeContextItems)
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

	function dismissConfirm() {
		setRecallArmedMode(undefined)
		setPendingConfirm(undefined)
	}

	function requestDeleteMessage(messageId: string) {
		if (!props.onDeleteMessage) return
		const item = props.timeline.find((entry) => entry.message.id === messageId)
		if (item) setPendingConfirm({ kind: 'message', action: 'delete', item })
	}

	function requestRegenerateMessage(messageId: string) {
		if (!props.onRegenerateMessage) return
		const item = props.timeline.find((entry) => entry.message.id === messageId)
		if (item) setPendingConfirm({ kind: 'message', action: 'regenerate', item })
	}

	function requestRecallMessage(messageId: string) {
		if (!props.onRecallMessage) return
		const item = props.timeline.find((entry) => entry.message.id === messageId)
		if (!item) return
		setRecallArmedMode(undefined)
		setPendingConfirm({ kind: 'message', action: 'recall', item })
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
		const fallbackText = item.message.parts
			.filter((p) => p.type === 'text')
			.map((p) => p.text)
			.join('\n')
		setInput(fallbackText)
		props.onUpdateInputDraft(fallbackText)
	}

	/** The first click arms a recall variant; the second click performs it. */
	function armOrConfirmRecall(mode: RecallArmedMode) {
		if (recallArmedMode() !== mode) {
			setRecallArmedMode(mode)
			return
		}
		const request = pendingConfirm()
		if (request?.kind !== 'message' || request.action !== 'recall') return
		dismissConfirm()
		void doRecallMessage(request.item, { restoreFiles: mode === 'restore' })
	}

	const hasReversibleOps = (item: ChatTimelineMessageItem) =>
		!!props.onRecallHasReversibleOps?.(item.message.id)

	function deleteMessageConfirmText(item: ChatTimelineMessageItem) {
		return item.message.role === 'user'
			? t('chatbox.ui.dialogs.deleteMessage.userConfirm')
			: t('chatbox.ui.dialogs.deleteMessage.assistantConfirm')
	}

	const recallOnlyConfirmLabel = () =>
		recallArmedMode() === 'only'
			? t('chatbox.ui.dialogs.recall.onlySecondTitle')
			: t('chatbox.ui.dialogs.recall.onlyConfirm')

	const recallRestoreConfirmLabel = () =>
		recallArmedMode() === 'restore'
			? t('chatbox.ui.dialogs.recall.restoreSecondTitle')
			: t('chatbox.ui.dialogs.recall.restoreConfirm')

	/** Copy and actions for the single confirmation slot. */
	const confirmDialog = createMemo((): ConfirmDialogView | undefined => {
		const request = pendingConfirm()
		if (!request) return undefined
		switch (request.kind) {
			case 'delete-session':
				return {
					title: t('chatbox.ui.dialogs.deleteSession.title'),
					message: t('chatbox.ui.dialogs.deleteSession.message'),
					confirmLabel: t('chatbox.ui.dialogs.deleteSession.confirm'),
					onConfirm: () => {
						dismissConfirm()
						void props.onDeleteSession(request.sessionId)
					},
				}
			case 'compress-context':
				return {
					title: t('chatbox.ui.dialogs.compressContext.title'),
					message: t('chatbox.ui.dialogs.compressContext.message'),
					confirmLabel: t('chatbox.ui.dialogs.compressContext.confirm'),
					onConfirm: () => {
						dismissConfirm()
						void props.onCompressContext()
					},
				}
			case 'message': {
				const { action, item } = request
				if (action === 'delete') {
					return {
						title: t('chatbox.ui.dialogs.deleteMessage.title'),
						message:
							deleteMessageConfirmText(item) +
							(hasReversibleOps(item)
								? `\n\n${t('chatbox.ui.dialogs.deleteMessage.toolRestoreWarning')}`
								: ''),
						confirmLabel: t('chatbox.ui.dialogs.deleteMessage.confirm'),
						onConfirm: () => {
							dismissConfirm()
							props.onDeleteMessage?.(item.message.id)
						},
					}
				}
				if (action === 'regenerate') {
					return {
						title: t('chatbox.ui.dialogs.regenerate.title'),
						message: t('chatbox.ui.dialogs.regenerate.message'),
						confirmLabel: t('chatbox.ui.dialogs.regenerate.confirm'),
						onConfirm: () => {
							dismissConfirm()
							props.onRegenerateMessage?.(item.message.id)
						},
					}
				}
				return {
					title: t('chatbox.ui.dialogs.recall.title'),
					message: t('chatbox.ui.dialogs.recall.message'),
					confirmLabel: recallOnlyConfirmLabel(),
					confirmClass:
						recallArmedMode() === 'only' ? 'mod-warning' : undefined,
					secondaryConfirmLabel: hasReversibleOps(item)
						? recallRestoreConfirmLabel()
						: undefined,
					secondaryConfirmClass:
						recallArmedMode() === 'restore' ? 'mod-warning' : undefined,
					actionsLayout: 'vertical',
					cancelPlacement: 'end',
					onConfirm: () => armOrConfirmRecall('only'),
					onSecondaryConfirm: () => armOrConfirmRecall('restore'),
				}
			}
		}
	})

	return (
		<div
			ref={chatboxRootEl}
			class={`:uno: chatbox-root relative flex h-full overflow-hidden bg-[var(--background-primary)] text-[var(--text-normal)] ${
				isFileDragActive() ? 'chatbox-file-drag-active' : ''
			}`}
			classList={{ 'is-compact': isCompactLayout() }}
		>
			<input
				ref={fileInputEl}
				type="file"
				accept={PICKER_ACCEPT}
				class=":uno: sr-only"
				onChange={(event) => {
					const files = Array.from(event.currentTarget.files ?? [])
					if (!files.length) return
					void addPickedFiles(files)
					event.currentTarget.value = ''
				}}
			/>
			<Show when={isFileDragActive()}>
				<div class=":uno: chatbox-file-drop-overlay pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed">
					<div class=":uno: rounded-full bg-[var(--background-primary)]/90 px-4 py-2 text-sm text-[var(--text-normal)] shadow-sm">
						{t('chatbox.ui.states.dragFilePrompt')}
					</div>
				</div>
			</Show>
			<div class=":uno: flex min-w-0 flex-1 flex-col overflow-hidden">
				{/* Header */}
				<Show when={!props.providerSetup}>
					<div class="ns-chatbox-header">
						<button
							class="ns-chatbox-nav-btn"
							type="button"
							aria-label={t('chatbox.ui.history.title')}
							title={t('chatbox.ui.history.title')}
							onClick={() => {
								setHistoryOpen((value) => !value)
								setModelPickerOpen(false)
							}}
						>
							<span class=":uno: i-lucide-history size-4 shrink-0" />
						</button>
						<div
							class="ns-chatbox-session-title"
							title={props.title || t('chatbox.newChat')}
						>
							{props.title || t('chatbox.newChat')}
						</div>
						<Show when={providerReady()}>
							<button
								class="ns-model-pill"
								type="button"
								aria-label={`${t('chatbox.ui.labels.provider')} / ${t('chatbox.ui.labels.model')}: ${modelPickerLabel()}`}
								title={modelPickerLabel()}
								onClick={() => {
									setModelPickerOpen(true)
									setHistoryOpen(false)
								}}
							>
								<span class=":uno: i-lucide-sparkles size-3.5 shrink-0 ns-model-pill-icon" />
								<span class="ns-model-pill-text">
									{isSmallChatbox()
										? compactModelPickerLabel()
										: modelPickerLabel()}
								</span>
								<span class=":uno: i-lucide-chevron-down size-3 shrink-0 ns-model-pill-chevron" />
							</button>
						</Show>
					</div>
				</Show>

				<div
					ref={splitLayoutEl}
					class=":uno: flex min-h-0 flex-1 flex-col overflow-hidden"
				>
					{/* Native anchoring preserves reading position above the bottom;
					    follow-bottom owns scrolling while pinned to the end. */}
					<div
						ref={messagesEl}
						class=":uno: ns-chatbox-messages min-h-0 flex-1 overflow-y-auto scrollbar-default"
						classList={{ 'is-provider-setup': !!props.providerSetup }}
						style={{ 'overflow-anchor': stickToBottom() ? 'none' : 'auto' }}
					>
						<Show
							when={props.providerSetup}
							fallback={
								<Show
									when={
										props.timeline.length > 0 ||
										props.pending.length > 0 ||
										isBusy()
									}
									fallback={
										<div class="ns-chatbox-empty">
											<div class="ns-chatbox-empty-card">
												<div class="ns-chatbox-empty-badge" aria-hidden="true">
													<span class=":uno: i-lucide-sparkles size-6 shrink-0" />
												</div>
												<div class="ns-chatbox-empty-title">
													{props.loading
														? t('chatbox.ui.states.loading')
														: props.title || t('chatbox.newChat')}
												</div>
												<Show when={!props.loading}>
													<div class="ns-chatbox-empty-subtitle">
														{t('chatbox.ui.states.empty')}
													</div>
												</Show>
											</div>
										</div>
									}
								>
									<MessageScrollContent
										class=":uno: ns-chatbox-message-content flex flex-col gap-[var(--ns-chatbox-gap)] px-[var(--ns-chatbox-pad-x)] pt-[var(--ns-chatbox-gap)] pb-[var(--ns-chatbox-gap)]"
										onResize={onMessageContentResize}
									>
										<Show when={hasEarlierTurns()}>
											<button
												type="button"
												class="ns-chatbox-load-earlier"
												onClick={loadEarlierTurns}
											>
												{t('chatbox.ui.actions.loadEarlierHistory')}
											</button>
										</Show>
										<TurnTimeline
											timeline={visibleTimeline()}
											sessionId={props.activeSessionId}
											runState={props.runState}
										>
											{(row, process) => (
												<MessageCard
													item={row().item}
													displayBlocks={row().blocks}
													process={process}
													now={now()}
													renderMarkdown={props.renderMarkdown}
													streaming={
														row().item.message.id === streamingMessageId()
													}
													onDeleteMessage={requestDeleteMessage}
													onRegenerateMessage={requestRegenerateMessage}
													onRecallMessage={requestRecallMessage}
													getSubagent={getSubagent}
													onOpenSubagent={setSelectedAgentId}
													onOpenFileChange={props.onOpenFileChange}
													onResolveResourceDataUrl={
														props.onResolveResourceDataUrl
													}
												/>
											)}
										</TurnTimeline>
										<RunStateCard
											runState={props.runState}
											onStop={props.onStopActiveRun}
										/>
										<PendingList pending={props.pending} />
									</MessageScrollContent>
								</Show>
							}
						>
							{(setup) => (
								<ProviderSetup
									initialDraft={props.providerSetupDraft}
									onboarding={{
										state: setup(),
										nutstore: props.nutstoreSetup,
										onStartNutstoreSetup: props.onStartNutstoreSetup,
										onOpenNutstoreAuthorization:
											props.onOpenNutstoreAuthorization,
										onCancelNutstoreSetup: props.onCancelNutstoreSetup,
									}}
									onFetchProviderSetupModels={props.onFetchProviderSetupModels}
									onCreateProviderSetupModel={props.onCreateProviderSetupModel}
									onSaveProviderSetup={props.onSaveProviderSetup}
									onEditModel={props.onEditProviderSetupModel}
								/>
							)}
						</Show>
					</div>

					<Show when={providerReady()}>
						<PaneResizer
							onResizeStart={onInputPaneResizeStart}
							onResize={onInputPaneResize}
							onResizeEnd={onInputPaneResizeEnd}
							onDblClick={resetInputPaneHeight}
						/>

						{/* Input */}
						<div
							ref={inputPaneEl}
							class=":uno: chatbox-input-pane chatbox-input-pane--resizable shrink-0 px-[var(--ns-chatbox-pad-x)] pb-2"
						>
							<div
								ref={(element) => {
									composerCardEl = element
								}}
								class="ns-composer-card"
							>
								<Show
									when={
										props.activeContextItems.length > 0 ||
										props.draft.userContext.length > 0
									}
								>
									<div class="chatbox-context-header">
										<div class="ns-composer-context-items">
											<Show when={props.activeContextItems.length > 0}>
												<ContextArea items={props.activeContextItems} />
											</Show>
											<Show when={props.draft.userContext.length > 0}>
												<ContextArea
													items={props.draft.userContext}
													onRemove={props.onRemoveUserContext}
												/>
											</Show>
										</div>
									</div>
								</Show>
								<ChatComposer
									ref={(element) => {
										inputEditorEl = element
									}}
									value={input()}
									sessionId={props.activeSessionId}
									placeholder={inputPlaceholder()}
									height={getTextareaHeightStyle()}
									completionAnchor={() => composerCardEl}
									onChange={(text) => {
										setInput(text)
										props.onUpdateInputDraft(text)
									}}
									mentionPaths={() => props.onListMentionPaths?.() ?? []}
									onMention={(path) => {
										void Promise.resolve(props.onDropContextItem(path)).catch(
											() => new Notice(t('chatbox.errors.mentionFailed')),
										)
									}}
									commands={() => [
										{
											name: 'file',
											description: t('chatbox.ui.actions.fileDescription'),
											label: t('chatbox.ui.actions.selectFile'),
											run: openFilePicker,
										},
										...(props.canCompress
											? [
													{
														name: 'compact',
														description: t(
															'chatbox.ui.actions.compactDescription',
														),
														label: t('chatbox.ui.actions.compressContext'),
														run: openCompressContextConfirm,
													},
												]
											: []),
										{
											name: 'new',
											description: t('chatbox.ui.actions.newDescription'),
											label: t('chatbox.newChat'),
											run: () => props.onNewSession(),
										},
									]}
									onSubmit={() => {
										void submit()
									}}
									onPasteImages={(files) => {
										void addPickedFiles(files)
									}}
								/>

								<div class="ns-composer-toolbar">
									<Show when={props.onWorkspaceHostChange}>
										<div class="ns-workspace-slot" ref={workspaceHostEl} />
									</Show>
									<div class="ns-composer-tools">
										<button
											class="ns-composer-tool-btn"
											type="button"
											title={t('chatbox.ui.actions.selectFile')}
											aria-label={t('chatbox.ui.actions.selectFile')}
											onClick={openFilePicker}
										>
											<span class=":uno: i-lucide-paperclip size-4 shrink-0" />
										</button>
										<button
											class="ns-composer-tool-btn"
											type="button"
											title={t('chatbox.ui.actions.compressContext')}
											aria-label={t('chatbox.ui.actions.compressContext')}
											disabled={!props.canCompress}
											onClick={openCompressContextConfirm}
										>
											<span class=":uno: i-lucide-minimize-2 size-4 shrink-0" />
										</button>
										<McpServersDialog
											servers={props.mcpServers}
											mountEl={dialogMountTarget().mountEl}
											contained={dialogMountTarget().contained}
											onToggle={props.onToggleSessionMcpServer}
										/>
										<button
											class="ns-composer-tool-btn"
											type="button"
											title={t('chatbox.newChat')}
											aria-label={t('chatbox.newChat')}
											onClick={() => props.onNewSession()}
										>
											<span class=":uno: i-lucide-square-pen size-4 shrink-0" />
										</button>
									</div>
									<button
										class=":uno: mod-cta ns-composer-send"
										type="button"
										aria-labelledby={sendLabelId}
										disabled={
											(!input().trim() &&
												!props.draft.userContext.length &&
												!props.activeContextItems.length) ||
											!props.canSend
										}
										onClick={() => void submit()}
										title={contextUsageTitle()}
									>
										<Show when={props.contextWindow}>
											<ContextRing
												used={contextUsedTokens()}
												total={props.contextWindow!}
												size={15}
												stroke={2.5}
											/>
										</Show>
										{/* Explicit references preserve the name when compact CSS hides the text. */}
										<span id={sendLabelId} class="ns-composer-send-label">
											{t('chatbox.ui.actions.send')}
										</span>
										<span class=":uno: i-lucide-arrow-up size-3.5 shrink-0" />
									</button>
								</div>
							</div>
						</div>
					</Show>
				</div>
			</div>

			{/* History bottom sheet */}
			<SessionHistorySheet
				open={historyOpen()}
				sessions={props.sessionHistory}
				activeSessionId={props.activeSessionId}
				activeSessionIsRunning={
					props.runState !== 'idle' ||
					Object.values(props.agentsById).some(
						(agent) => agent.status === 'running' || agent.status === 'queued',
					)
				}
				otherBusySessionIds={props.otherBusySessionIds}
				mountEl={dialogMountTarget().mountEl}
				contained={dialogMountTarget().contained}
				onClose={() => setHistoryOpen(false)}
				onNewSession={props.onNewSession}
				onSwitchSession={props.onSwitchSession}
				onExportSession={(sessionId) =>
					void props.onExportSession(sessionId, dialogMountTarget())
				}
				onDelete={(sessionId) =>
					setPendingConfirm({ kind: 'delete-session', sessionId })
				}
			/>

			<Show when={modelPickerOpen()}>
				<ModelPickerDialog
					providers={props.providers}
					selectedProviderId={props.selectedProviderId}
					selectedModelId={props.selectedModelId}
					mountEl={dialogMountTarget().mountEl}
					contained={dialogMountTarget().contained}
					onSelectProvider={props.onSelectProvider}
					onSelectModel={props.onSelectModel}
					onClose={() => setModelPickerOpen(false)}
				/>
			</Show>

			<SubagentTimelineDialog
				agent={selectedAgent()}
				now={now()}
				mountEl={dialogMountTarget().mountEl}
				contained={dialogMountTarget().contained}
				renderMarkdown={props.renderMarkdown}
				getSubagent={getSubagent}
				onSelectAgent={setSelectedAgentId}
				onOpenFileChange={props.onOpenFileChange}
				onClose={() => setSelectedAgentId(undefined)}
			/>

			{/* One confirmation slot: destructive prompts never stack. */}
			<Show when={confirmDialog()}>
				{(dialog) => (
					<ConfirmDialog
						view={dialog()}
						mountEl={dialogMountTarget().mountEl}
						contained={dialogMountTarget().contained}
						onCancel={dismissConfirm}
					/>
				)}
			</Show>
		</div>
	)
}

export default Chatbox

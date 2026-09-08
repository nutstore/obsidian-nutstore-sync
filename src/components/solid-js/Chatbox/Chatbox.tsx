import { Notice } from 'obsidian'
import {
	For,
	Show,
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	onMount,
} from 'solid-js'
import {
	createFileContextItem,
	createImageContextItem,
	createPendingContextItem,
} from '~/ai/chat/context/user-context'
import { resolveUsedContextTokens } from '~/ai/chat/domain'
import { CHATBOX_DIALOG_CONTAINED_MIN_WIDTH } from '~/ai/chat/ui/modal-mount'
import type { ChatTimelineMessageItem, ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '../i18n'
import { ConfirmDialog } from './components/ConfirmDialog'
import { ContextArea } from './components/ContextArea'
import { ContextRing } from './components/ContextRing'
import { McpServersDialog } from './components/McpServersDialog'
import { MessageCard } from './components/MessageCard'
import { ModelPickerDialog } from './components/ModelPickerDialog'
import { PaneResizer } from './components/PaneResizer'
import { PendingList } from './components/PendingList'
import { RunStateCard } from './components/RunStateCard'
import { SessionHistorySheet } from './components/SessionHistorySheet'
import { SubagentTimelineDialog } from './components/SubagentTimelineDialog'
import { decideDropRoute, hasDragItems } from './drop-utils'
import { shouldSubmitChatInput } from './utils'

const INPUT_HEIGHT_STORAGE_KEY = 'nutstore-sync.chatbox.input-height'
const LEGACY_INPUT_HEIGHT_STORAGE_KEY =
	'nutstore-sync.chatbox.desktop-input-height'
const DEFAULT_INPUT_HEIGHT = 184
const DEFAULT_COMPACT_INPUT_HEIGHT = 144
const INPUT_MIN_HEIGHT = 128
const COMPACT_INPUT_MIN_HEIGHT = 104
const INPUT_ABSOLUTE_MIN_HEIGHT = 72
const COMPACT_INPUT_ABSOLUTE_MIN_HEIGHT = 64
const MESSAGES_MIN_HEIGHT = 200
const COMPACT_MESSAGES_MIN_HEIGHT = 120
const RESIZER_HITBOX_HEIGHT = 10
const INPUT_MAX_VIEWPORT_RATIO = 0.6
const COMPACT_INPUT_MAX_VIEWPORT_RATIO = 0.45
const COMPACT_LAYOUT_MAX_WIDTH = 768
const SM_MAX_WIDTH = 640
const PICKER_ACCEPT = 'image/*,.txt,.md,.markdown'
const TEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'markdown'])

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

function Chatbox(props: ChatboxProps) {
	type RecallArmedMode = 'only' | 'restore'
	const [input, setInput] = createSignal('')
	const [isComposing, setIsComposing] = createSignal(false)
	const [historyOpen, setHistoryOpen] = createSignal(false)
	const [selectedAgentId, setSelectedAgentId] = createSignal<string>()
	const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
	const [sessionPendingDeleteId, setSessionPendingDeleteId] =
		createSignal<string>()
	const [pendingDeleteMessage, setPendingDeleteMessage] =
		createSignal<ChatTimelineMessageItem>()
	const [pendingRegenerateMessage, setPendingRegenerateMessage] =
		createSignal<ChatTimelineMessageItem>()
	const [pendingRecallMessage, setPendingRecallMessage] =
		createSignal<ChatTimelineMessageItem>()
	const [pendingCompressContextConfirm, setPendingCompressContextConfirm] =
		createSignal(false)
	const [recallArmedMode, setRecallArmedMode] = createSignal<RecallArmedMode>()
	const [chatboxContainerWidth, setChatboxContainerWidth] = createSignal(0)
	const [inputPaneHeight, setInputPaneHeight] = createSignal<number>()
	const [stickToBottom, setStickToBottom] = createSignal(true)
	const [isFileDragActive, setIsFileDragActive] = createSignal(false)
	const [now, setNow] = createSignal(Date.now())
	let chatboxRootEl: HTMLDivElement | undefined
	let messagesEl: HTMLDivElement | undefined
	let splitLayoutEl: HTMLDivElement | undefined
	let inputPaneEl: HTMLDivElement | undefined
	let fileInputEl: HTMLInputElement | undefined
	let inputTextareaEl: HTMLTextAreaElement | undefined
	let previousActiveSessionId: string | undefined
	let defaultInputHeight = DEFAULT_INPUT_HEIGHT
	let dragStartHeight = 0

	createEffect(() => {
		const hasLiveDuration =
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
			)
		if (!hasLiveDuration) return
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

	function getDefaultInputPaneHeight() {
		return isCompactLayout()
			? DEFAULT_COMPACT_INPUT_HEIGHT
			: DEFAULT_INPUT_HEIGHT
	}

	function getInputMinHeight() {
		return isCompactLayout() ? COMPACT_INPUT_MIN_HEIGHT : INPUT_MIN_HEIGHT
	}

	function getInputAbsoluteMinHeight() {
		return isCompactLayout()
			? COMPACT_INPUT_ABSOLUTE_MIN_HEIGHT
			: INPUT_ABSOLUTE_MIN_HEIGHT
	}

	function getMessagesMinHeight() {
		return isCompactLayout() ? COMPACT_MESSAGES_MIN_HEIGHT : MESSAGES_MIN_HEIGHT
	}

	function getInputMaxViewportRatio() {
		return isCompactLayout()
			? COMPACT_INPUT_MAX_VIEWPORT_RATIO
			: INPUT_MAX_VIEWPORT_RATIO
	}

	function dismissInputFocus() {
		const activeElement = getViewDocument().activeElement
		if (activeElement instanceof HTMLElement) {
			activeElement.blur()
		}
		inputTextareaEl?.blur()
	}

	function openCompressContextConfirm() {
		dismissInputFocus()
		getViewWindow().requestAnimationFrame(() => {
			setPendingCompressContextConfirm(true)
		})
	}

	const isBusy = () => props.runState !== 'idle'
	const streamingMessageId = createMemo(() => {
		if (!isBusy()) return undefined
		for (let index = props.timeline.length - 1; index >= 0; index -= 1) {
			const message = props.timeline[index]?.message
			if (message?.role === 'assistant') return message.id
		}
		return undefined
	})

	const contextUsedTokens = () => resolveUsedContextTokens(props.usage)
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

	const lastMessageFingerprint = () => {
		const item = props.timeline.at(-1)
		if (!item) return 'empty'
		const textLength = item.message.parts
			.filter((part) => part.type === 'text')
			.reduce((total, part) => total + part.text.length, 0)
		const blockFingerprint = item.displayBlocks
			.map((block) => {
				if (block.kind === 'content') return `c:${block.parts.length}`
				if (block.kind === 'reasoning') return `r:${block.part.text.length}`
				if (block.kind === 'tool-call') {
					return `tc:${block.toolCall.toolCallId}:${block.toolCall.state}`
				}
				return `sn:${JSON.stringify(block.notification)}`
			})
			.join('|')
		return `${item.message.id}:${textLength}:${blockFingerprint}:${item.message.role}`
	}

	const selectedProvider = () =>
		props.providers.find((provider) => provider.id === props.selectedProviderId)
	const dialogMountTarget = () => {
		const contained =
			chatboxContainerWidth() >= CHATBOX_DIALOG_CONTAINED_MIN_WIDTH &&
			!!chatboxRootEl
		return {
			mountEl: contained
				? chatboxRootEl
				: (chatboxRootEl?.ownerDocument?.body ?? getViewDocument().body),
			contained,
			hostEl: chatboxRootEl,
		}
	}
	const selectedAgent = () => {
		const agentId = selectedAgentId()
		return agentId ? props.agentsById[agentId] : undefined
	}
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
		if (!inputPaneEl || !inputTextareaEl) {
			return 0
		}
		const paneHeight = inputPaneEl.getBoundingClientRect().height
		const textareaHeight = inputTextareaEl.getBoundingClientRect().height
		return Math.max(0, Math.round(paneHeight - textareaHeight))
	}

	function getMaxInputPaneHeight() {
		const viewportMax = Math.floor(
			getViewWindow().innerHeight * getInputMaxViewportRatio(),
		)
		const splitHeight = splitLayoutEl?.getBoundingClientRect().height ?? 0
		if (splitHeight <= 0) {
			return Math.max(getInputMinHeight(), viewportMax)
		}
		const messagesBound = Math.floor(
			splitHeight - getMessagesMinHeight() - RESIZER_HITBOX_HEIGHT,
		)
		const maxHeight = Math.min(messagesBound, viewportMax)
		return Math.max(getInputAbsoluteMinHeight(), maxHeight)
	}

	function clampInputPaneHeight(height: number) {
		const maxHeight = getMaxInputPaneHeight()
		const minHeight = Math.min(getInputMinHeight(), maxHeight)
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

	function getTextareaHeightStyle() {
		const paneHeight = inputPaneHeight()
		if (typeof paneHeight !== 'number') {
			return undefined
		}
		const chromeHeight = getInputPaneChromeHeight()
		return `${Math.max(getInputAbsoluteMinHeight(), paneHeight - chromeHeight)}px`
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

	function handleRootDragEnter(event: DragEvent) {
		if (!hasDragItems(event)) {
			return
		}
		event.preventDefault()
		setIsFileDragActive(true)
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

	createEffect(
		on(
			() => [
				props.activeSessionId,
				props.timeline.length,
				props.pending.length,
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
		if (!inputTextareaEl) {
			return
		}
		defaultInputHeight =
			Math.round(inputPaneEl?.getBoundingClientRect().height ?? 0) ||
			getDefaultInputPaneHeight()
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
		const onDragEnter = (event: DragEvent) => handleRootDragEnter(event)
		const onDragOver = (event: DragEvent) => handleRootDragOver(event)
		const onDragLeave = (event: DragEvent) => handleRootDragLeave(event)
		const onDrop = (event: DragEvent) => {
			void handleRootDrop(event)
		}
		root.addEventListener('dragenter', onDragEnter, true)
		root.addEventListener('dragover', onDragOver, true)
		root.addEventListener('dragleave', onDragLeave, true)
		root.addEventListener('drop', onDrop, true)
		onCleanup(() => {
			root.removeEventListener('dragenter', onDragEnter, true)
			root.removeEventListener('dragover', onDragOver, true)
			root.removeEventListener('dragleave', onDragLeave, true)
			root.removeEventListener('drop', onDrop, true)
		})
	})

	createEffect(() => {
		if (!chatboxRootEl || !props.onCaptureActiveContext) {
			return
		}
		const root = chatboxRootEl
		const onPointerDownCapture = () => props.onCaptureActiveContext?.()
		root.addEventListener('pointerdown', onPointerDownCapture, true)
		onCleanup(() => {
			root.removeEventListener('pointerdown', onPointerDownCapture, true)
		})
	})

	createEffect(() => {
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

	createEffect(() => {
		if (!inputPaneEl || !inputTextareaEl) {
			return
		}
		const observer = new ResizeObserver(() => {
			const height = inputPaneHeight()
			if (typeof height !== 'number') {
				return
			}
			const clampedHeight = clampInputPaneHeight(height)
			if (clampedHeight !== height) {
				applyInputPaneHeight(clampedHeight, true)
			}
		})
		observer.observe(inputPaneEl)
		observer.observe(inputTextareaEl)
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
		scrollMessagesToBottom('auto')
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
		const item = props.timeline.find((item) => item.message.id === messageId)
		if (!item) return
		setPendingDeleteMessage(item)
	}

	function requestRegenerateMessage(messageId: string) {
		if (!props.onRegenerateMessage) return
		const item = props.timeline.find((item) => item.message.id === messageId)
		if (!item) return
		setPendingRegenerateMessage(item)
	}

	function requestRecallMessage(messageId: string) {
		if (!props.onRecallMessage) return
		const item = props.timeline.find((item) => item.message.id === messageId)
		if (!item) return
		setRecallArmedMode(undefined)
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
		const fallbackText = item.message.parts
			.filter((p) => p.type === 'text')
			.map((p) => p.text)
			.join('\n')
		setInput(fallbackText)
		props.onUpdateInputDraft(fallbackText)
	}

	async function confirmRecallMessage() {
		const item = pendingRecallMessage()
		if (!item) return
		setRecallArmedMode(undefined)
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

	async function confirmCompressContext() {
		setPendingCompressContextConfirm(false)
		await props.onCompressContext()
	}

	const deleteMessageConfirmText = () => {
		const item = pendingDeleteMessage()
		if (!item) return ''
		switch (item.message.role) {
			case 'user':
				return t('chatbox.ui.dialogs.deleteMessage.userConfirm')
			default:
				return t('chatbox.ui.dialogs.deleteMessage.assistantConfirm')
		}
	}

	const deleteMessageHasReversibleOps = () =>
		Boolean(
			pendingDeleteMessage() &&
			props.onRecallHasReversibleOps?.(pendingDeleteMessage()!.message.id),
		)

	const recallHasReversibleOps = () => {
		const item = pendingRecallMessage()
		if (!item) return false
		if (props.onRecallHasReversibleOps) {
			return props.onRecallHasReversibleOps(item.message.id)
		}
		return false
	}

	async function confirmRecallAndRestoreMessage() {
		const item = pendingRecallMessage()
		if (!item) return
		setRecallArmedMode(undefined)
		setPendingRecallMessage(undefined)
		await doRecallMessage(item, { restoreFiles: true })
	}

	const confirmRecallOnlyButton = () => {
		if (recallArmedMode() === 'only') {
			void confirmRecallMessage()
			return
		}
		setRecallArmedMode('only')
	}

	const confirmRecallRestoreButton = () => {
		if (recallArmedMode() === 'restore') {
			void confirmRecallAndRestoreMessage()
			return
		}
		setRecallArmedMode('restore')
	}

	const recallOnlyConfirmLabel = () =>
		recallArmedMode() === 'only'
			? t('chatbox.ui.dialogs.recall.onlySecondTitle')
			: t('chatbox.ui.dialogs.recall.onlyConfirm')

	const recallRestoreConfirmLabel = () =>
		recallArmedMode() === 'restore'
			? t('chatbox.ui.dialogs.recall.restoreSecondTitle')
			: t('chatbox.ui.dialogs.recall.restoreConfirm')

	return (
		<div
			ref={chatboxRootEl}
			class={`:uno: relative flex h-full overflow-hidden bg-[var(--background-primary)] text-[var(--text-normal)] ${
				isFileDragActive() ? 'chatbox-file-drag-active' : ''
			}`}
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
				<div class=":uno: relative flex shrink-0 items-center gap-2 border-b border-[var(--background-modifier-border)] px-2 py-2">
					<button
						class=":uno: inline-flex size-8 shrink-0 items-center justify-center text-[var(--text-muted)] transition-colors !bg-transparent hover:text-[var(--interactive-accent)] focus-visible:text-[var(--interactive-accent)]"
						type="button"
						aria-label={t('chatbox.ui.history.title')}
						title={t('chatbox.ui.history.title')}
						onClick={() => {
							setHistoryOpen((value) => !value)
							setModelPickerOpen(false)
						}}
					>
						<span class=":uno: i-lucide-menu size-5 shrink-0" />
					</button>
					<div class=":uno: min-w-0 flex-1 truncate text-sm font-semibold">
						{props.title || t('chatbox.newChat')}
					</div>
					<Show
						when={isSmallChatbox()}
						fallback={
							<button
								class=":uno: max-w-56 min-w-34 text-sm"
								type="button"
								onClick={() => {
									setModelPickerOpen(true)
									setHistoryOpen(false)
								}}
							>
								<div class=":uno: truncate">{modelPickerLabel()}</div>
							</button>
						}
					>
						<button
							class=":uno: inline-flex size-6 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
							type="button"
							aria-label={`${t('chatbox.ui.labels.provider')} / ${t('chatbox.ui.labels.model')}`}
							title={`${t('chatbox.ui.labels.provider')} / ${t('chatbox.ui.labels.model')}`}
							onClick={() => {
								setModelPickerOpen(true)
								setHistoryOpen(false)
							}}
						>
							<span class=":uno: i-lucide-sliders-horizontal size-3 shrink-0" />
						</button>
					</Show>
				</div>

				<div
					ref={splitLayoutEl}
					class=":uno: flex min-h-0 flex-1 flex-col overflow-hidden"
				>
					{/* Messages */}
					<div
						ref={messagesEl}
						class=":uno: min-h-0 flex-1 overflow-y-auto px-3 pb-3 scrollbar-default"
					>
						<Show
							when={
								props.timeline.length > 0 ||
								props.pending.length > 0 ||
								isBusy()
							}
							fallback={
								<div class=":uno: flex h-full items-center justify-center text-sm text-[var(--text-muted)]">
									{props.loading
										? t('chatbox.ui.states.loading')
										: t('chatbox.ui.states.empty')}
								</div>
							}
						>
							<div class=":uno: flex flex-col gap-3">
								<For each={props.timeline}>
									{(item) => (
										<MessageCard
											item={item}
											now={now()}
											renderMarkdown={props.renderMarkdown}
											streaming={item.message.id === streamingMessageId()}
											onDeleteMessage={requestDeleteMessage}
											onRegenerateMessage={requestRegenerateMessage}
											onRecallMessage={requestRecallMessage}
											getSubagent={(agentId) => props.agentsById[agentId]}
											onOpenSubagent={setSelectedAgentId}
											onOpenFileChange={props.onOpenFileChange}
											onResolveResourceDataUrl={props.onResolveResourceDataUrl}
										/>
									)}
								</For>
								<RunStateCard
									runState={props.runState}
									onStop={props.onStopActiveRun}
								/>
								<PendingList pending={props.pending} />
							</div>
						</Show>
					</div>

					<PaneResizer
						onResizeStart={onInputPaneResizeStart}
						onResize={onInputPaneResize}
						onResizeEnd={onInputPaneResizeEnd}
						onDblClick={resetInputPaneHeight}
					/>

					{/* Input */}
					<div
						ref={inputPaneEl}
						class={`:uno: chatbox-input-pane shrink-0 px-2 pb-1 ${'chatbox-input-pane--resizable'}`}
					>
						<div class="chatbox-context-header">
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
						<textarea
							ref={inputTextareaEl}
							class=":uno: chatbox-input flex-1 w-full rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] text-sm outline-none"
							style={(() => {
								const height = getTextareaHeightStyle()
								return height ? { height } : undefined
							})()}
							placeholder={t('chatbox.ui.placeholders.input')}
							value={input()}
							onInput={(event) => {
								const nextInput = event.currentTarget.value
								setInput(nextInput)
								props.onUpdateInputDraft(nextInput)
							}}
							onPaste={(event) => {
								const imageFiles = Array.from(event.clipboardData?.items ?? [])
									.filter(
										(item) =>
											item.kind === 'file' && item.type.startsWith('image/'),
									)
									.map((item) => item.getAsFile())
									.filter((file): file is File => !!file)
								if (!imageFiles.length) return
								event.preventDefault()
								void addPickedFiles(imageFiles)
							}}
							onCompositionStart={() => setIsComposing(true)}
							onCompositionEnd={() => setIsComposing(false)}
							onKeyDown={(event) => {
								if (shouldSubmitChatInput(event, isComposing())) {
									event.preventDefault()
									void submit()
								}
							}}
						/>

						<div class=":uno: mt-3 flex items-center justify-between gap-3">
							<div class=":uno: flex flex-wrap items-center gap-2">
								<button
									class=":uno: inline-flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
									type="button"
									title={t('chatbox.ui.actions.selectFile')}
									aria-label={t('chatbox.ui.actions.selectFile')}
									onClick={openFilePicker}
								>
									<span class=":uno: i-lucide-paperclip size-4 shrink-0" />
								</button>
								<button
									class=":uno: inline-flex size-9 shrink-0 items-center justify-center rounded-full disabled:opacity-50"
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
									class=":uno: inline-flex size-9 shrink-0 items-center justify-center rounded-full"
									type="button"
									title={t('chatbox.newChat')}
									aria-label={t('chatbox.newChat')}
									onClick={() => props.onNewSession()}
								>
									<span class=":uno: i-lucide-square-pen size-4 shrink-0" />
								</button>
							</div>
							<button
								class=":uno: mod-cta inline-flex items-center gap-1.5"
								type="button"
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
										size={16}
										stroke={3}
										title={contextUsageTitle()}
									/>
								</Show>
								{t('chatbox.ui.actions.send')}
							</button>
						</div>
					</div>
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
				onDelete={(sessionId) => setSessionPendingDeleteId(sessionId)}
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
				getSubagent={(agentId) => props.agentsById[agentId]}
				onSelectAgent={setSelectedAgentId}
				onOpenFileChange={props.onOpenFileChange}
				onClose={() => setSelectedAgentId(undefined)}
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

			<Show when={pendingCompressContextConfirm()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.compressContext.title')}
					message={t('chatbox.ui.dialogs.compressContext.message')}
					confirmLabel={t('chatbox.ui.dialogs.compressContext.confirm')}
					mountEl={dialogMountTarget().mountEl}
					contained={dialogMountTarget().contained}
					onCancel={() => setPendingCompressContextConfirm(false)}
					onConfirm={() => void confirmCompressContext()}
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
			<Show when={pendingRecallMessage()}>
				<ConfirmDialog
					title={t('chatbox.ui.dialogs.recall.title')}
					message={t('chatbox.ui.dialogs.recall.message')}
					confirmLabel={recallOnlyConfirmLabel()}
					confirmClass={
						recallArmedMode() === 'only' ? 'mod-warning' : undefined
					}
					secondaryConfirmLabel={
						recallHasReversibleOps() ? recallRestoreConfirmLabel() : undefined
					}
					secondaryConfirmClass={
						recallArmedMode() === 'restore' ? 'mod-warning' : undefined
					}
					actionsLayout="vertical"
					cancelPlacement="end"
					mountEl={dialogMountTarget().mountEl}
					contained={dialogMountTarget().contained}
					onCancel={() => {
						setRecallArmedMode(undefined)
						setPendingRecallMessage(undefined)
					}}
					onConfirm={confirmRecallOnlyButton}
					onSecondaryConfirm={confirmRecallRestoreButton}
				/>
			</Show>
		</div>
	)
}

export default Chatbox

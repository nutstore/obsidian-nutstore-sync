import {
	Component,
	ItemView,
	MarkdownView,
	MarkdownRenderer,
	normalizePath,
	type TAbstractFile,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from 'obsidian'
import type { EditorView } from '@codemirror/view'
import {
	createImageContextItem,
	createPendingContextItem,
	createSelectedTextContextItem,
	createVaultPathContextItem,
	getUserContextItemHash,
	type UserContextItem,
	type SelectedTextContextItem,
} from '~/ai/chat/context/user-context'
import type { ChatboxController, ChatboxProps } from '~/ai/chat/ui/types'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import {
	hideChatboxSelectionHighlight,
	showChatboxSelectionHighlight,
} from './chatbox-selection-highlight'
import { mountChatbox } from '../components/solid-js'

export const CHATBOX_VIEW_TYPE = 'nutstore-sync-chatbox'

function normalizeDroppedVaultPath(path: string): string | null {
	let value = path.trim()
	if (!value) return null
	if (value.startsWith('obsidian://open?')) {
		try {
			const url = new URL(value)
			value = url.searchParams.get('file') ?? value
		} catch {
			// Keep the raw value as a fallback candidate.
		}
	}
	try {
		value = decodeURIComponent(value)
	} catch {
		// Keep the raw value when it is not URI-encoded.
	}
	value = value.replace(/^\[\[/, '').replace(/\]\]$/, '')
	value = value.split('|')[0]?.trim() ?? ''
	value = value.replace(/^\/+/, '').replace(/\/+$/, '').trim()
	return value ? normalizePath(value) : null
}

export default class ChatboxView extends ItemView {
	private rootEl!: HTMLDivElement
	private controller?: ChatboxController
	private unsub?: () => void
	private unsubWindowMigrated?: () => void
	private lastActiveMarkdownLeaf: WorkspaceLeaf | null = null
	private activeFilePathSnapshot?: string
	private activeSelectionSnapshot?: SelectedTextContextItem
	private highlightedEditorView?: EditorView
	private preservingSelectionForChatFocus = false
	private readonly renderMarkdown: NonNullable<ChatboxProps['renderMarkdown']> =
		async (el: HTMLElement, markdown: string) => {
			const component = new Component()
			this.addChild(component)
			component.load()

			const fallbackText = markdown
			const renderedEl = el.ownerDocument.createElement('div')

			try {
				await MarkdownRenderer.render(
					this.app,
					markdown,
					renderedEl,
					'',
					component,
				)
			} catch (error) {
				logger.error('Error rendering chat markdown:', error)
				component.unload()
				el.replaceChildren()
				el.textContent = fallbackText
				return
			}

			el.replaceChildren(...Array.from(renderedEl.childNodes))
			if (!el.childNodes.length) {
				el.textContent = fallbackText
			}

			return () => {
				component.unload()
				el.replaceChildren()
			}
		}

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: NutstorePlugin,
	) {
		super(leaf)
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				this.handleActiveLeafChange(leaf)
				this.controller?.update(this.getChatboxProps())
			}),
		)
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.captureActiveContextSnapshot()
				this.controller?.update(this.getChatboxProps())
			}),
		)
		this.registerDomEvent(document, 'selectionchange', () => {
			if (this.preservingSelectionForChatFocus) {
				return
			}
			if (!this.app.workspace.getActiveViewOfType(MarkdownView)) {
				return
			}
			this.captureActiveContextSnapshot()
			this.controller?.update(this.getChatboxProps())
		})
	}

	getViewType() {
		return CHATBOX_VIEW_TYPE
	}

	getDisplayText() {
		return i18n.t('chatbox.title')
	}

	getIcon() {
		return 'bot'
	}

	private resolveDroppedAbstractFile(path: string): TAbstractFile | null {
		const normalized = normalizeDroppedVaultPath(path)
		if (!normalized) return null
		const candidates = [normalized]
		if (!/\.[^/]+$/.test(normalized)) {
			candidates.push(`${normalized}.md`)
		}
		for (const candidate of candidates) {
			const abstract = this.plugin.app.vault.getAbstractFileByPath(candidate)
			if (abstract) return abstract
		}

		const basename = normalized.split('/').pop()
		if (!basename) return null
		const matches = this.plugin.app.vault.getAllLoadedFiles().filter((file) => {
			const filePath = normalizePath(file.path)
			const filePathWithoutMd = filePath.replace(/\.md$/i, '')
			return (
				file.name === basename ||
				filePathWithoutMd === normalized ||
				filePathWithoutMd.endsWith(`/${basename}`)
			)
		})
		return matches.length === 1 ? matches[0] : null
	}

	private isVaultImageFile(file: TFile): boolean {
		return file.path.match(/\.(png|jpe?g|gif|webp|bmp)$/i) !== null
	}

	private async createDroppedImageContextItem(file: TFile) {
		const extension = file.extension.toLowerCase()
		const data = await this.app.vault.readBinary(file)
		return createImageContextItem(new Blob([data]), {
			mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
			name: file.name,
			size: file.stat.size,
		})
	}

	private clearActiveContextSnapshot() {
		this.activeFilePathSnapshot = undefined
		this.activeSelectionSnapshot = undefined
	}

	private clearSelectionHighlight() {
		if (!this.highlightedEditorView) {
			return
		}
		try {
			hideChatboxSelectionHighlight(this.highlightedEditorView)
		} catch {
			// Ignore cleanup failures from destroyed views.
		}
		this.highlightedEditorView = undefined
	}

	private resolveMarkdownView(allowFallback = false): MarkdownView | null {
		const activeMarkdownView =
			this.app.workspace.getActiveViewOfType(MarkdownView)
		if (activeMarkdownView) {
			return activeMarkdownView
		}
		if (
			allowFallback &&
			this.lastActiveMarkdownLeaf?.view instanceof MarkdownView
		) {
			return this.lastActiveMarkdownLeaf.view
		}
		return null
	}

	private getEditorView(markdownView?: MarkdownView | null): EditorView | null {
		return markdownView?.editor?.cm ?? null
	}

	private persistSelectionHighlight(allowFallback = false) {
		const markdownView = this.resolveMarkdownView(allowFallback)
		const view = this.getEditorView(markdownView)
		if (!view) {
			this.clearSelectionHighlight()
			return
		}
		const selection = view.state.selection.main
		if (selection.from === selection.to) {
			this.clearSelectionHighlight()
			return
		}
		if (this.highlightedEditorView && this.highlightedEditorView !== view) {
			this.clearSelectionHighlight()
		}
		showChatboxSelectionHighlight(view, selection.from, selection.to)
		this.highlightedEditorView = view
	}

	private handleActiveLeafChange(leaf: WorkspaceLeaf | null) {
		if (
			this.highlightedEditorView &&
			leaf?.getViewState().type !== CHATBOX_VIEW_TYPE
		) {
			this.clearSelectionHighlight()
		}
		if (leaf?.view instanceof MarkdownView) {
			this.lastActiveMarkdownLeaf = leaf
			this.preservingSelectionForChatFocus = false
			this.captureActiveContextSnapshot()
			return
		}
		if (leaf?.getViewState().type === CHATBOX_VIEW_TYPE) {
			this.persistSelectionHighlight(true)
			return
		}
		this.preservingSelectionForChatFocus = false
		this.clearActiveContextSnapshot()
	}

	private captureActiveContextSnapshot(allowFallback = false) {
		const markdownView = this.resolveMarkdownView(allowFallback)
		if (!markdownView) {
			const activeFile = this.app.workspace.getActiveFile()
			if (!activeFile) {
				this.clearActiveContextSnapshot()
			}
			this.clearSelectionHighlight()
			return
		}
		this.activeFilePathSnapshot = markdownView.file?.path
		const editor = markdownView.editor
		const selection = editor?.listSelections?.()[0]
		const selectedText = editor?.getSelection() ?? ''
		if (!markdownView.file?.path) {
			this.clearActiveContextSnapshot()
			this.clearSelectionHighlight()
			return
		}
		if (!selection || !selectedText.trim()) {
			this.activeSelectionSnapshot = undefined
			this.clearSelectionHighlight()
			return
		}
		this.activeSelectionSnapshot = createSelectedTextContextItem({
			type: 'selection',
			filePath: markdownView.file.path,
			range: {
				from: { line: selection.anchor.line, ch: selection.anchor.ch },
				to: { line: selection.head.line, ch: selection.head.ch },
			},
			selectedText,
		})
	}

	private getActiveContextItems(): UserContextItem[] {
		if (this.activeSelectionSnapshot) {
			return [this.activeSelectionSnapshot]
		}
		if (this.activeFilePathSnapshot) {
			return [createVaultPathContextItem(this.activeFilePathSnapshot, 'file')]
		}
		return []
	}

	private getChatboxProps(): ChatboxProps {
		const viewProps = this.plugin.chatService.getViewProps()
		const activeContextItems = this.getActiveContextItems().filter((item) => {
			const hash = getUserContextItemHash(item)
			return !viewProps.draft.userContext.some(
				(contextItem) => getUserContextItemHash(contextItem) === hash,
			)
		})
		return {
			...viewProps,
			activeContextItems,
			renderMarkdown: this.renderMarkdown,
			onSendMessage: (text: string, contextItems?: UserContextItem[]) =>
				this.plugin.chatService.sendMessage(text, contextItems ?? []),
			onCaptureActiveContext: () => {
				this.captureActiveContextSnapshot(true)
				this.preservingSelectionForChatFocus = !!this.activeSelectionSnapshot
				this.persistSelectionHighlight(true)
				this.controller?.update(this.getChatboxProps())
			},
			onAddUserContext: (item) => {
				this.plugin.chatService.addUserContext(item)
			},
			onDropContextItem: async (path: string) => {
				const abstract = this.resolveDroppedAbstractFile(path)
				if (!abstract) return
				if (abstract instanceof TFolder) {
					this.plugin.chatService.addUserContext(
						createVaultPathContextItem(abstract.path, 'folder'),
					)
					return
				}
				if (abstract instanceof TFile) {
					if (this.isVaultImageFile(abstract)) {
						const pending = createPendingContextItem('image', abstract.name)
						this.plugin.chatService.addUserContext(pending)
						try {
							const item = await this.createDroppedImageContextItem(abstract)
							this.plugin.chatService.resolvePendingContextItem(
								pending.id,
								item,
							)
						} catch (error) {
							this.plugin.chatService.resolvePendingContextItem(
								pending.id,
								null,
							)
							throw error
						}
						return
					}
					this.plugin.chatService.addUserContext(
						createVaultPathContextItem(abstract.path, 'file'),
					)
					return
				}
			},
			onRemoveUserContext: (index: number) => {
				this.plugin.chatService.removeUserContext(index)
			},
			onResolvePendingContextItem: (id: string, replacement) => {
				this.plugin.chatService.resolvePendingContextItem(id, replacement)
			},
		}
	}

	private remountChatbox() {
		this.unsub?.()
		this.unsub = undefined
		this.controller?.destroy()
		this.controller = mountChatbox(this.rootEl, this.getChatboxProps())
		this.unsub = this.plugin.chatService.subscribe(() => {
			this.controller?.update(this.getChatboxProps())
		})
	}

	async onOpen() {
		this.contentEl.empty()
		this.rootEl = this.contentEl.createDiv({
			cls: 'nutstore-chatbox-view h-full',
		})
		this.captureActiveContextSnapshot(true)
		this.plugin.chatService.setChatModalHost(this.rootEl)
		await this.plugin.chatService.ensureSession()
		this.unsubWindowMigrated?.()
		this.unsubWindowMigrated = this.rootEl.onWindowMigrated(() => {
			this.plugin.chatService.setChatModalHost(this.rootEl)
			this.remountChatbox()
		})
		this.remountChatbox()
	}

	async onClose() {
		this.clearSelectionHighlight()
		this.unsubWindowMigrated?.()
		this.unsubWindowMigrated = undefined
		this.unsub?.()
		this.unsub = undefined
		this.controller?.destroy()
		this.controller = undefined
		this.plugin.chatService.setChatModalHost(undefined)
		this.contentEl.empty()
	}
}

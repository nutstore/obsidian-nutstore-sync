import type { Modal } from 'obsidian'

export const CHATBOX_DIALOG_CONTAINED_MIN_WIDTH = 486

export interface ChatModalMountTarget {
	mountEl: HTMLElement
	contained: boolean
	hostEl?: HTMLElement
}

function getChatboxWidth(rootEl?: HTMLElement | null) {
	const boundingWidth = rootEl?.getBoundingClientRect().width ?? 0
	return boundingWidth > 0 ? boundingWidth : (rootEl?.clientWidth ?? 0)
}

export function resolveChatModalMountTarget(
	rootEl?: HTMLElement | null,
): ChatModalMountTarget {
	const ownerDocument = rootEl?.ownerDocument ?? document
	const width = getChatboxWidth(rootEl)
	if (rootEl?.isConnected && width >= CHATBOX_DIALOG_CONTAINED_MIN_WIDTH) {
		return {
			mountEl: rootEl,
			contained: true,
			hostEl: rootEl,
		}
	}
	return {
		mountEl: ownerDocument.body ?? document.body,
		contained: false,
		hostEl: rootEl?.isConnected ? rootEl : undefined,
	}
}

export function applyObsidianModalMountTarget(
	modal: Modal,
	target?: ChatModalMountTarget,
): (() => void) | undefined {
	if (!target) return

	const modalWithElements = modal as Modal & {
		containerEl?: HTMLElement
		modalEl?: HTMLElement
	}
	const containerEl = modalWithElements.containerEl
	if (!containerEl) return

	const modalEl = modalWithElements.modalEl
	const hadDimClass = containerEl.classList.contains('mod-dim')
	const hostEl =
		target.hostEl ?? (target.contained ? target.mountEl : undefined)
	const fallbackEl = hostEl?.ownerDocument?.body ?? target.mountEl
	const updateMount = () => {
		const contained =
			!!hostEl?.isConnected &&
			getChatboxWidth(hostEl) >= CHATBOX_DIALOG_CONTAINED_MIN_WIDTH
		const nextMountEl = contained ? hostEl : fallbackEl
		if (nextMountEl?.isConnected && containerEl.parentElement !== nextMountEl) {
			nextMountEl.appendChild(containerEl)
		}
		containerEl.classList.toggle(
			'ns-chatbox-contained-modal-container',
			contained,
		)
		if (hadDimClass) {
			containerEl.classList.toggle('mod-dim', !contained)
		}
		modalEl?.classList.toggle('ns-chatbox-contained-modal', contained)
	}

	updateMount()

	if (!hostEl) return
	const ResizeObserverConstructor =
		hostEl.ownerDocument?.defaultView?.ResizeObserver
	if (!ResizeObserverConstructor) return
	const observer = new ResizeObserverConstructor(updateMount)
	observer.observe(hostEl)

	return () => {
		observer.disconnect()
		if (hadDimClass) {
			containerEl.classList.add('mod-dim')
		}
	}
}

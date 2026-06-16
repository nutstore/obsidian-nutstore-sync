import type { Modal } from 'obsidian'

export const CHATBOX_DIALOG_CONTAINED_MIN_WIDTH = 486

export interface ChatModalMountTarget {
	mountEl: HTMLElement
	contained: boolean
}

export function resolveChatModalMountTarget(
	rootEl?: HTMLElement | null,
): ChatModalMountTarget {
	const ownerDocument = rootEl?.ownerDocument ?? document
	const width =
		rootEl?.getBoundingClientRect().width ?? rootEl?.clientWidth ?? 0
	if (rootEl?.isConnected && width >= CHATBOX_DIALOG_CONTAINED_MIN_WIDTH) {
		return {
			mountEl: rootEl,
			contained: true,
		}
	}
	return {
		mountEl: ownerDocument.body ?? document.body,
		contained: false,
	}
}

export function applyObsidianModalMountTarget(
	modal: Modal,
	target?: ChatModalMountTarget,
) {
	if (!target?.contained) {
		return
	}

	const modalWithElements = modal as Modal & {
		containerEl?: HTMLElement
		modalEl?: HTMLElement
	}
	const containerEl = modalWithElements.containerEl
	if (!containerEl || !target.mountEl.isConnected) {
		return
	}

	target.mountEl.appendChild(containerEl)
	containerEl.classList.add('ns-chatbox-contained-modal-container')
	modalWithElements.modalEl?.classList.add('ns-chatbox-contained-modal')
}

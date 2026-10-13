import { throwIfAborted } from '~/utils/abort'

/** A pending confirmation must settle when its owning operation is cancelled. */
export function closeModalOnAbort<
	T extends { close(): void; onClose(): unknown },
>(modal: T, signal?: AbortSignal): T {
	throwIfAborted(signal)
	if (!signal) return modal
	const close = () => modal.close()
	const onClose = modal.onClose.bind(modal)
	modal.onClose = () => {
		signal.removeEventListener('abort', close)
		return onClose()
	}
	signal.addEventListener('abort', close, { once: true })
	return modal
}

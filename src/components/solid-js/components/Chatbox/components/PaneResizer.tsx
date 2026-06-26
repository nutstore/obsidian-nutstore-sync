import { createSignal, onCleanup } from 'solid-js'

interface PaneResizerProps {
	onResizeStart?: () => void
	onResize: (deltaY: number) => void
	onResizeEnd?: () => void
	onDblClick?: () => void
}

export function PaneResizer(props: PaneResizerProps) {
	const [isResizing, setIsResizing] = createSignal(false)
	let startY = 0
	let activeDoc: Document | undefined
	let removeListeners: (() => void) | undefined

	function stopResize() {
		removeListeners?.()
		removeListeners = undefined
		setIsResizing(false)
		activeDoc?.body.classList.remove('chatbox-resize-active')
		activeDoc = undefined
	}

	function onPointerDown(event: PointerEvent) {
		if (event.button !== 0) {
			return
		}

		event.preventDefault()
		stopResize()
		props.onResizeStart?.()
		const onResize = props.onResize
		const onResizeEnd = props.onResizeEnd
		const doc =
			(event.currentTarget as { ownerDocument?: Document } | null)
				?.ownerDocument ?? document
		activeDoc = doc
		startY = event.clientY
		setIsResizing(true)
		doc.body.classList.add('chatbox-resize-active')

		const onPointerMove = (moveEvent: PointerEvent) => {
			onResize(startY - moveEvent.clientY)
		}

		const onPointerUp = () => {
			onResizeEnd?.()
			stopResize()
		}

		doc.addEventListener('pointermove', onPointerMove)
		doc.addEventListener('pointerup', onPointerUp)
		doc.addEventListener('pointercancel', onPointerUp)
		removeListeners = () => {
			doc.removeEventListener('pointermove', onPointerMove)
			doc.removeEventListener('pointerup', onPointerUp)
			doc.removeEventListener('pointercancel', onPointerUp)
		}
	}

	onCleanup(() => stopResize())

	return (
		<div
			class="chatbox-resizer px-3"
			classList={{ 'is-resizing': isResizing() }}
			role="separator"
			aria-orientation="horizontal"
			onPointerDown={onPointerDown}
			onDblClick={() => props.onDblClick?.()}
		>
			<div class="chatbox-resizer-line" />
		</div>
	)
}

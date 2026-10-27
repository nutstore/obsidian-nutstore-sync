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
	let overlay: HTMLDivElement | undefined
	let releasePointer: (() => void) | undefined
	let removeListeners: (() => void) | undefined

	function stopResize() {
		removeListeners?.()
		removeListeners = undefined
		releasePointer?.()
		releasePointer = undefined
		setIsResizing(false)
		overlay?.remove()
		overlay = undefined
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
		const target = event.currentTarget as HTMLDivElement
		const doc = target.ownerDocument
		// Keep pointer-up on the divider so the browser can synthesize dblclick.
		target.setPointerCapture(event.pointerId)
		releasePointer = () => {
			if (target.hasPointerCapture(event.pointerId)) {
				target.releasePointerCapture(event.pointerId)
			}
		}
		startY = event.clientY
		setIsResizing(true)
		// A drag surface keeps the cursor stable over controls and embedded frames.
		overlay = doc.body.createDiv({ cls: 'chatbox-resize-overlay' })

		const onPointerMove = (moveEvent: PointerEvent) => {
			if (moveEvent.pointerId !== event.pointerId) return
			onResize(startY - moveEvent.clientY)
		}

		const onPointerUp = (upEvent: PointerEvent) => {
			if (upEvent.pointerId !== event.pointerId) return
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
			class=":uno: chatbox-resizer px-3"
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

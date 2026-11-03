import { createVirtualizer, type VirtualItem } from '@tanstack/solid-virtual'
import { onCleanup, type Accessor } from 'solid-js'

export interface VirtualRowsOptions {
	/** Total number of rows, tracked reactively. */
	count: Accessor<number>
	/** Height used for a row until it has been measured. */
	estimateSize: number
	/** The element that scrolls; read lazily because it mounts after setup. */
	scrollElement: () => HTMLElement | undefined
}

export interface VirtualRows {
	/** Rows to mount now. Entries are stable per index, so scrolling keeps DOM. */
	rows: Accessor<VirtualItem[]>
	/** Height of the full list, so the scrollbar reflects every row. */
	totalSize: Accessor<number>
	/** Report a mounted row's real height; later offsets follow measured heights. */
	measure: (index: number, node: HTMLElement) => void
	scrollToTop: () => void
}

/**
 * Windowed rows for lists that can reach thousands of entries. Callers render
 * `rows()` absolutely positioned inside a spacer of `totalSize()` height.
 */
export function createVirtualRows(options: VirtualRowsOptions): VirtualRows {
	const virtualizer = createVirtualizer<HTMLElement, HTMLElement>({
		get count() {
			return options.count()
		},
		getScrollElement: () => options.scrollElement() ?? null,
		estimateSize: () => options.estimateSize,
		overscan: 8,
	})

	// A row is not attached when its ref runs, so measure once layout exists.
	const pending = new Map<number, HTMLElement>()
	let timer: number | undefined
	const measure = (index: number, node: HTMLElement) => {
		pending.set(index, node)
		timer ??= window.setTimeout(() => {
			timer = undefined
			for (const [row, element] of pending) {
				if (element.isConnected)
					virtualizer.resizeItem(row, element.offsetHeight)
			}
			pending.clear()
		}, 8)
	}
	onCleanup(() => {
		window.clearTimeout(timer)
		pending.clear()
	})

	return {
		rows: () => virtualizer.getVirtualItems(),
		totalSize: () => virtualizer.getTotalSize(),
		measure,
		scrollToTop: () => virtualizer.scrollToOffset(0),
	}
}

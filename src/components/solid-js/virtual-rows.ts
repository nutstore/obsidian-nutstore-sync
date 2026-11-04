import { createVirtualizer, type VirtualItem } from '@tanstack/solid-virtual'
import type { Accessor } from 'solid-js'

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
	/**
	 * Ref for a row element carrying `data-index={row.index}`. Its height stays
	 * tracked while mounted, so wrapping, rotation or a different item at the
	 * same index re-flow later rows without the caller re-measuring.
	 */
	measure: (node: HTMLElement) => void
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
		measureElement: (element) => element.offsetHeight,
	})

	return {
		rows: () => virtualizer.getVirtualItems(),
		totalSize: () => virtualizer.getTotalSize(),
		// A ref runs before the row is attached; observe it once it is in the DOM.
		measure: (node) =>
			queueMicrotask(() => {
				if (node.isConnected) virtualizer.measureElement(node)
			}),
		scrollToTop: () => virtualizer.scrollToOffset(0),
	}
}

import { For } from 'solid-js'
import { createVirtualRows } from '../virtual-rows'

/** One unreadable path, already phrased for display. */
export interface ScanIssueRow {
	path: string
	step: string
	cause: string
}

export interface ScanIssueListProps {
	items: ScanIssueRow[]
}

const ROW_ESTIMATE = 72

/**
 * Cards for unreadable paths, windowed so thousands of them stay cheap. Styling
 * lives in the scoped `.scan-issues-*` rules in global.css.
 */
export default function ScanIssueList(props: ScanIssueListProps) {
	let scrollEl: HTMLDivElement | undefined
	const { rows, totalSize, measure } = createVirtualRows({
		count: () => props.items.length,
		estimateSize: ROW_ESTIMATE,
		scrollElement: () => scrollEl,
	})

	return (
		<div
			class="scan-issues-list"
			role="list"
			ref={scrollEl}
			style={{ '--scan-issues-content-height': `${totalSize()}px` }}
		>
			<div class="scan-issues-spacer" style={{ height: `${totalSize()}px` }}>
				<For each={rows()}>
					{(row) => {
						const item = () => props.items[row.index]
						return (
							<div
								class="scan-issues-row"
								role="listitem"
								aria-posinset={row.index + 1}
								aria-setsize={props.items.length}
								ref={(el) => measure(row.index, el)}
								style={{ transform: `translateY(${row.start}px)` }}
							>
								<div class="scan-issues-item">
									<div class="scan-issues-path">{item()?.path}</div>
									<div class="scan-issues-detail">
										<span class="scan-issues-step">{item()?.step}</span>
										<span class="scan-issues-cause">{item()?.cause}</span>
									</div>
								</div>
							</div>
						)
					}}
				</For>
			</div>
		</div>
	)
}

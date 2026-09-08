import {
	elementScroll,
	observeElementOffset,
	observeElementRect,
	Virtualizer,
	type Rect,
	type VirtualItem,
	type VirtualizerOptions,
} from '@tanstack/solid-virtual'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { t } from '../i18n'

export interface TaskSelectionItem {
	id: string
	action: string
	localPath: string
	remotePath: string
	checked: boolean
}

export interface TaskSelectionVirtualListProps {
	items: TaskSelectionItem[]
	onToggle: (index: number, checked: boolean) => void
	onToggleMany: (indices: number[], checked: boolean) => void
}

interface ScoredItem {
	item: TaskSelectionItem
	originalIndex: number
	score: number
}

const ALL_TYPE = '__all__'
const ROW_ESTIMATE = 95
const SEPARATOR = /[/\\.,\s_-]/
const estimateSize = () => ROW_ESTIMATE

function subsequenceScore(text: string, q: string): number {
	if (!q) return 0
	if (text.length < q.length) return -1
	const idx = text.indexOf(q)
	if (idx !== -1) {
		return 10000 - idx + (idx === 0 ? 500 : 0)
	}
	const positions: number[] = []
	let from = 0
	for (let i = 0; i < q.length; i++) {
		const found = text.indexOf(q[i], from)
		if (found === -1) return -1
		positions.push(found)
		from = found + 1
	}
	let score = 1000
	if (positions[0] === 0) score += 500
	let gapUnits = 0
	let boundaryCrossings = 0
	for (let i = 1; i < positions.length; i++) {
		const gap = positions[i] - positions[i - 1] - 1
		if (gap > 0) {
			gapUnits += gap
			for (let j = positions[i - 1] + 1; j < positions[i]; j++) {
				if (SEPARATOR.test(text[j])) boundaryCrossings++
			}
		}
	}
	score -= gapUnits
	score -= boundaryCrossings * 30
	score -= positions[0]
	return score
}

interface VirtualRow {
	index: number
	start: number
	end: number
}

function projectRows(items: VirtualItem[]): VirtualRow[] {
	return items
		.filter((v): v is VirtualItem => v != null)
		.map((v) => ({ index: v.index, start: v.start, end: v.end }))
}

export default function TaskSelectionVirtualList(
	props: TaskSelectionVirtualListProps,
) {
	const [typeFilter, setTypeFilter] = createSignal<string>(ALL_TYPE)
	const [query, setQuery] = createSignal('')
	let scrollEl: HTMLDivElement | undefined

	const searchable = createMemo(() =>
		props.items.map((it) => ({
			action: it.action,
			local: it.localPath.toLowerCase(),
			remote: it.remotePath.toLowerCase(),
		})),
	)

	const typeOptions = createMemo(() => {
		const q = query().trim().toLowerCase()
		const counts = new Map<string, number>()
		let total = 0
		const list = searchable()
		for (let i = 0; i < list.length; i++) {
			const s = list[i]
			const score =
				q.length === 0
					? 0
					: Math.max(
							subsequenceScore(s.local, q),
							subsequenceScore(s.remote, q),
						)
			if (score === -1) continue
			counts.set(s.action, (counts.get(s.action) ?? 0) + 1)
			total++
		}
		return { list: [...counts.entries()], total }
	})

	const filteredItems = createMemo(() => {
		const q = query().trim().toLowerCase()
		const type = typeFilter()
		const list = searchable()
		const out: ScoredItem[] = []
		for (let i = 0; i < list.length; i++) {
			if (type !== ALL_TYPE && list[i].action !== type) continue
			const score =
				q.length === 0
					? 0
					: Math.max(
							subsequenceScore(list[i].local, q),
							subsequenceScore(list[i].remote, q),
						)
			if (score === -1) continue
			out.push({ item: props.items[i], originalIndex: i, score })
		}
		if (q.length > 0) {
			out.sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
		}
		return out
	})

	const visibleItems = () => filteredItems()
	const allChecked = () =>
		visibleItems().length > 0 && visibleItems().every((f) => f.item.checked)
	const someChecked = () =>
		visibleItems().some((f) => f.item.checked) && !allChecked()

	const totalItems = () => props.items.length

	const getScrollEl = () => scrollEl ?? null

	const [virtualRows, setVirtualRows] = createSignal<VirtualRow[]>([])

	let virtualOptions: VirtualizerOptions<HTMLElement, HTMLElement> = {
		count: 0,
		getScrollElement: getScrollEl,
		estimateSize,
		observeElementRect(
			instance: Virtualizer<HTMLElement, HTMLElement>,
			cb: (rect: Rect) => void,
		) {
			const el = instance.options.getScrollElement()
			if (el) {
				cb({
					width: el.clientWidth || el.getBoundingClientRect().width,
					height: el.clientHeight || el.getBoundingClientRect().height,
				})
			}
			return observeElementRect(instance, cb)
		},
		observeElementOffset,
		scrollToFn: elementScroll,
		onChange(instance: Virtualizer<HTMLElement, HTMLElement>) {
			setVirtualRows(projectRows(instance.getVirtualItems()))
		},
		overscan: 8,
	}

	const virtualizer = new Virtualizer<HTMLElement, HTMLElement>(virtualOptions)

	createEffect(() => {
		const count = filteredItems().length
		if (virtualOptions.count !== count) {
			virtualOptions = {
				...virtualOptions,
				count,
			}
			virtualizer.setOptions(virtualOptions)
			virtualizer._willUpdate()
			setVirtualRows(projectRows(virtualizer.getVirtualItems()))
		}
	})

	const pendingRows = new Map<number, HTMLElement>()
	const [rowTick, bumpRowTick] = createSignal(0)

	const registerRow = (index: number, node: HTMLElement) => {
		pendingRows.set(index, node)
		bumpRowTick((t) => t + 1)
	}

	createEffect(() => {
		void rowTick()
		if (pendingRows.size > 0) {
			const rows = [...pendingRows]
			pendingRows.clear()
			window.setTimeout(() => {
				for (const [index, node] of rows) {
					if (node.isConnected) {
						virtualizer.resizeItem(index, node.offsetHeight)
					}
				}
			}, 8)
		}
	})

	createEffect(() => {
		void typeFilter()
		void query()
		virtualizer.scrollToOffset(0)
	})

	return (
		<div class=":uno: w-full h-full border border-[var(--background-modifier-border)] rounded flex flex-col overflow-hidden bg-[var(--background-primary)]">
			<div class=":uno: px-3 py-2 border-b border-[var(--background-modifier-border)] bg-[var(--background-secondary)] flex flex-wrap items-center gap-2">
				<select
					class=":uno: text-xs px-2 py-1 rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-normal)] max-w-[16rem]"
					value={typeFilter()}
					onChange={(e) => setTypeFilter(e.currentTarget.value)}
				>
					<option value={ALL_TYPE}>
						{t('taskSelectionVirtualList.filter.all', {
							count: typeOptions().total,
						})}
					</option>
					<For each={typeOptions().list}>
						{(opt) => (
							<option value={opt[0]}>
								{opt[0]} ({opt[1]})
							</option>
						)}
					</For>
				</select>
				<input
					type="text"
					placeholder={t('taskSelectionVirtualList.filter.searchPlaceholder')}
					value={query()}
					onInput={(e) => setQuery(e.currentTarget.value)}
					class=":uno: flex-1 min-w-[12rem] text-xs px-2 py-1 rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-normal)]"
				/>
			</div>

			<div class=":uno: grid grid-cols-[2rem_4rem_1fr_1fr] items-center bg-[var(--background-secondary)] text-xs text-[var(--text-muted)] font-bold select-none border-b border-[var(--background-modifier-border)]">
				<div class=":uno: flex items-center justify-center py-2">
					<input
						type="checkbox"
						checked={allChecked()}
						ref={(el) => {
							createEffect(() => {
								el.indeterminate = someChecked()
							})
						}}
						onClick={(e) => e.stopPropagation()}
						onChange={() =>
							props.onToggleMany(
								visibleItems().map((f) => f.originalIndex),
								!allChecked(),
							)
						}
					/>
				</div>
				<div class=":uno: p-2 border-l border-[var(--background-modifier-border)]">
					{t('taskSelectionVirtualList.labels.action')}
				</div>
				<div class=":uno: p-2 border-l border-[var(--background-modifier-border)]">
					{t('taskSelectionVirtualList.labels.localPath')}
				</div>
				<div class=":uno: p-2 border-l border-[var(--background-modifier-border)]">
					{t('taskSelectionVirtualList.labels.remotePath')}
				</div>
			</div>

			<Show
				when={filteredItems().length === 0}
				fallback={
					<div ref={scrollEl} class=":uno: flex-1 overflow-auto">
						<div
							style={{
								height: `${virtualizer.getTotalSize()}px`,
								position: 'relative',
								width: '100%',
							}}
						>
							<For each={virtualRows()}>
								{(vr) => {
									if (!vr) return null
									const scored = filteredItems()[vr.index]
									if (!scored) return null
									return (
										<div
											ref={(el) => {
												registerRow(vr.index, el)
											}}
											class=":uno: grid grid-cols-[2rem_4rem_1fr_1fr] items-start text-sm hover:bg-[var(--background-modifier-hover)] cursor-pointer border-b border-[var(--background-modifier-border)]"
											style={{
												position: 'absolute',
												top: 0,
												left: 0,
												width: '100%',
												transform: `translateY(${vr.start}px)`,
											}}
											onClick={() =>
												props.onToggle(
													scored.originalIndex,
													!scored.item.checked,
												)
											}
										>
											<div class=":uno: flex items-start justify-center px-2 py-2">
												<input
													type="checkbox"
													checked={scored.item.checked}
													onClick={(e) => e.stopPropagation()}
													onChange={(e) =>
														props.onToggle(
															scored.originalIndex,
															e.currentTarget.checked,
														)
													}
												/>
											</div>
											<div class=":uno: p-2 text-[var(--text-normal)] border-l border-[var(--background-modifier-border)] break-all">
												{scored.item.action}
											</div>
											<div class=":uno: p-2 text-[var(--text-normal)] border-l border-[var(--background-modifier-border)] break-all">
												{scored.item.localPath}
											</div>
											<div class=":uno: p-2 text-[var(--text-normal)] border-l border-[var(--background-modifier-border)] break-all">
												{scored.item.remotePath}
											</div>
										</div>
									)
								}}
							</For>
						</div>
					</div>
				}
			>
				<div class=":uno: flex-1 flex items-center justify-center p-6 text-sm text-[var(--text-muted)]">
					{t('taskSelectionVirtualList.filter.empty')}
				</div>
			</Show>

			<div class=":uno: px-3 py-2 border-t border-[var(--background-modifier-border)] bg-[var(--background-secondary)] flex items-center justify-end text-xs text-[var(--text-muted)]">
				<span>
					{t('taskSelectionVirtualList.footer.totalItems', {
						count: totalItems(),
					})}
				</span>
				<Show when={filteredItems().length !== totalItems()}>
					<span class=":uno: ml-1">
						{t('taskSelectionVirtualList.footer.filtered', {
							count: filteredItems().length,
						})}
					</span>
				</Show>
			</div>
		</div>
	)
}

import {
	ColumnDef,
	createSolidTable,
	flexRender,
	getCoreRowModel,
	getPaginationRowModel,
} from '@tanstack/solid-table'
import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import { t } from '../../i18n'

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
	onToggleAll?: (checked: boolean) => void
}

export default function TaskSelectionVirtualList(
	props: TaskSelectionVirtualListProps,
) {
	const allChecked = () =>
		props.items.length > 0 && props.items.every((item) => item.checked)
	const someChecked = () =>
		props.items.some((item) => item.checked) && !allChecked()

	const columns = createMemo<ColumnDef<TaskSelectionItem>[]>(() => [
		{
			id: 'execute',
			header: () => (
				<div class="px-2 py-2 flex items-center justify-center">
					<input
						type="checkbox"
						checked={allChecked()}
						ref={(el) => {
							createEffect(() => {
								el.indeterminate = someChecked()
							})
						}}
						onClick={(e) => e.stopPropagation()}
						onChange={() => props.onToggleAll?.(!allChecked())}
					/>
				</div>
			),
			cell: (ctx) => (
				<div class="px-2 py-2 flex items-start justify-center">
					<input
						type="checkbox"
						checked={ctx.row.original.checked}
						onClick={(e) => e.stopPropagation()}
						onChange={(e) =>
							props.onToggle(ctx.row.index, e.currentTarget.checked)
						}
					/>
				</div>
			),
		},
		{
			id: 'action',
			header: t('taskSelectionVirtualList.labels.action'),
			accessorFn: (row) => row.action,
			cell: (ctx) => (
				<div class="px-2 py-2 text-sm text-[var(--text-normal)]">
					{ctx.getValue<string>()}
				</div>
			),
		},
		{
			id: 'localPath',
			header: t('taskSelectionVirtualList.labels.localPath'),
			accessorFn: (row) => row.localPath,
			cell: (ctx) => (
				<div class="px-2 py-2 text-sm break-all text-[var(--text-normal)]">
					{ctx.getValue<string>()}
				</div>
			),
		},
		{
			id: 'remotePath',
			header: t('taskSelectionVirtualList.labels.remotePath'),
			accessorFn: (row) => row.remotePath,
			cell: (ctx) => (
				<div class="px-2 py-2 text-sm break-all text-[var(--text-normal)]">
					{ctx.getValue<string>()}
				</div>
			),
		},
	])

	const [pagination, setPagination] = createSignal({
		pageIndex: 0,
		pageSize: 100,
	})

	const table = createSolidTable<TaskSelectionItem>({
		get data() {
			return props.items
		},
		get columns() {
			return columns()
		},
		getCoreRowModel: getCoreRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		onPaginationChange: setPagination,
		state: {
			get pagination() {
				return pagination()
			},
		},
	})

	const rows = () => table.getRowModel().rows
	const totalItems = () => props.items.length
	const pageCount = () => table.getPageCount()
	const canPreviousPage = () => pagination().pageIndex > 0
	const canNextPage = () => {
		const count = pageCount()
		return count > 0 && pagination().pageIndex < count - 1
	}
	const currentPage = () => (pageCount() === 0 ? 0 : pagination().pageIndex + 1)
	const pageInfoText = () =>
		t('taskSelectionVirtualList.pagination.pageInfo', {
			current: currentPage(),
			total: pageCount(),
		})
	const totalItemsText = () =>
		t('taskSelectionVirtualList.pagination.totalItems', { count: totalItems() })

	createEffect(() => {
		const count = pageCount()
		const current = pagination().pageIndex
		if (count === 0 && current !== 0) {
			setPagination((prev) => ({ ...prev, pageIndex: 0 }))
			return
		}
		if (count > 0 && current > count - 1) {
			setPagination((prev) => ({ ...prev, pageIndex: count - 1 }))
		}
	})

	return (
		<div class="w-full h-full border border-[var(--background-modifier-border)] rounded flex flex-col overflow-hidden">
			<div class="flex-1 overflow-auto">
				<table class="task-list-table m-0">
					<thead>
						<For each={table.getHeaderGroups()}>
							{(headerGroup) => (
								<tr>
									<For each={headerGroup.headers}>
										{(header) => (
											<th>
												<Show when={!header.isPlaceholder}>
													{flexRender(
														header.column.columnDef.header,
														header.getContext(),
													)}
												</Show>
											</th>
										)}
									</For>
								</tr>
							)}
						</For>
					</thead>
					<tbody>
						<For each={rows()}>
							{(row) => (
								<tr
									onClick={() =>
										props.onToggle(row.index, !row.original.checked)
									}
								>
									<For each={row.getVisibleCells()}>
										{(cell) => (
											<td>
												{flexRender(
													cell.column.columnDef.cell,
													cell.getContext(),
												)}
											</td>
										)}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</div>

			<div class="px-3 py-2 border-t border-[var(--background-modifier-border)] bg-[var(--background-secondary)] flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
				<button
					type="button"
					class="px-2 py-1 rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-normal)] disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={!canPreviousPage()}
					onClick={() => setPagination((prev) => ({ ...prev, pageIndex: 0 }))}
				>
					{t('taskSelectionVirtualList.pagination.first')}
				</button>
				<button
					type="button"
					class="px-2 py-1 rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-normal)] disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={!canPreviousPage()}
					onClick={() =>
						setPagination((prev) => ({
							...prev,
							pageIndex: Math.max(0, prev.pageIndex - 1),
						}))
					}
				>
					{t('taskSelectionVirtualList.pagination.previous')}
				</button>
				<button
					type="button"
					class="px-2 py-1 rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-normal)] disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={!canNextPage()}
					onClick={() =>
						setPagination((prev) => {
							const last = Math.max(pageCount() - 1, 0)
							return {
								...prev,
								pageIndex: Math.min(last, prev.pageIndex + 1),
							}
						})
					}
				>
					{t('taskSelectionVirtualList.pagination.next')}
				</button>
				<button
					type="button"
					class="px-2 py-1 rounded border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-normal)] disabled:opacity-50 disabled:cursor-not-allowed"
					disabled={!canNextPage()}
					onClick={() =>
						setPagination((prev) => ({
							...prev,
							pageIndex: Math.max(pageCount() - 1, 0),
						}))
					}
				>
					{t('taskSelectionVirtualList.pagination.last')}
				</button>
				<div class="flex-1" />
				<span class="ml-1 text-[var(--text-normal)]">{pageInfoText()}</span>
				<span class="ml-1">{totalItemsText()}</span>
			</div>
		</div>
	)
}

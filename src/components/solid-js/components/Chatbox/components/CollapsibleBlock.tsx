import type { JSX } from 'solid-js'

export function CollapsibleBlock(props: {
	title: string
	iconClass: string
	headerActions?: JSX.Element
	children: JSX.Element
}) {
	return (
		<details class="group rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)]">
			<summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs text-[var(--text-muted)] marker:hidden">
				<div class="flex min-w-0 items-center gap-2">
					<span class="flex size-6 p-1 shrink-0 items-center justify-center rounded-full border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-muted)]">
						<span class={`${props.iconClass} size-4 shrink-0`} />
					</span>
					<div class="truncate font-medium text-[var(--text-normal)]">
						{props.title}
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					{props.headerActions}
					<span class="i-lucide-chevron-down size-4 shrink-0 transition-transform group-open:rotate-180" />
				</div>
			</summary>
			<div class="border-t border-[var(--background-modifier-border)] px-3 py-3">
				{props.children}
			</div>
		</details>
	)
}

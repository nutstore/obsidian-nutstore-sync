import type { JSX } from 'solid-js'

export function CollapsibleBlock(props: {
	summary: JSX.Element
	headerActions?: JSX.Element
	open?: boolean
	onOpenChange?: (open: boolean) => void
	children: JSX.Element
}) {
	return (
		<details
			class=":uno: group rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)]"
			open={props.open}
			onToggle={(event) => props.onOpenChange?.(event.currentTarget.open)}
		>
			<summary class=":uno: flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs text-[var(--text-muted)] marker:hidden">
				{props.summary}
				<div class=":uno: flex shrink-0 items-center gap-1">
					{props.headerActions}
					<span class=":uno: i-lucide-chevron-down size-4 shrink-0 transition-transform group-open:rotate-180" />
				</div>
			</summary>
			{props.children}
		</details>
	)
}

export function TitledCollapsibleBlock(props: {
	title: JSX.Element
	iconClass: string
	iconLabel?: string
	headerActions?: JSX.Element
	open?: boolean
	onOpenChange?: (open: boolean) => void
	children: JSX.Element
}) {
	return (
		<CollapsibleBlock
			summary={
				<div class=":uno: flex min-w-0 items-center gap-2">
					<span
						class=":uno: flex size-5 shrink-0 items-center justify-center text-[var(--text-muted)]"
						title={props.iconLabel}
						aria-label={props.iconLabel}
						role="img"
					>
						<span
							class={`:uno: ${props.iconClass} size-5 shrink-0`}
							aria-hidden="true"
						/>
					</span>
					<div class=":uno: truncate font-medium text-[var(--text-normal)]">
						{props.title}
					</div>
				</div>
			}
			headerActions={props.headerActions}
			open={props.open}
			onOpenChange={props.onOpenChange}
		>
			<div class=":uno: border-t border-[var(--background-modifier-border)] px-3 py-3">
				{props.children}
			</div>
		</CollapsibleBlock>
	)
}

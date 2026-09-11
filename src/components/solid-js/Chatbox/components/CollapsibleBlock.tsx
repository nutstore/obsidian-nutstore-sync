import { Show, createContext, useContext, type JSX } from 'solid-js'

/** Process descendants share a presentation without changing their content or behavior. */
export const CollapsibleAppearance = createContext<'card' | 'plain'>('card')

export function CollapsibleBlock(props: {
	summary: JSX.Element
	headerActions?: JSX.Element
	appearance?: 'card' | 'plain'
	open?: boolean
	onOpenChange?: (open: boolean) => void
	children: JSX.Element
}) {
	const inheritedAppearance = useContext(CollapsibleAppearance)
	const appearance = () => props.appearance ?? inheritedAppearance
	return (
		<details
			class={
				appearance() === 'plain'
					? ':uno: chatbox-collapsible chatbox-collapsible-plain min-w-0'
					: ':uno: chatbox-collapsible rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)]'
			}
			open={props.open}
			onToggle={(event) => props.onOpenChange?.(event.currentTarget.open)}
		>
			<summary class=":uno: flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs text-[var(--text-muted)] marker:hidden">
				<Show when={appearance() === 'plain'}>
					<span
						class=":uno: chatbox-collapsible-leading-chevron i-lucide-chevron-right size-4 shrink-0 transition-transform"
						aria-hidden="true"
					/>
				</Show>
				{props.summary}
				<div class=":uno: flex shrink-0 items-center gap-1">
					{props.headerActions}
					<Show when={appearance() !== 'plain'}>
						<span
							class=":uno: chatbox-collapsible-chevron i-lucide-chevron-down size-4 shrink-0 transition-transform"
							aria-hidden="true"
						/>
					</Show>
				</div>
			</summary>
			{props.children}
		</details>
	)
}

export function TitledCollapsibleBlock(props: {
	title: JSX.Element
	iconClass?: string
	iconLabel?: string
	headerActions?: JSX.Element
	appearance?: 'card' | 'plain'
	open?: boolean
	onOpenChange?: (open: boolean) => void
	children: JSX.Element
}) {
	const inheritedAppearance = useContext(CollapsibleAppearance)
	const appearance = () => props.appearance ?? inheritedAppearance
	return (
		<CollapsibleBlock
			appearance={appearance()}
			summary={
				<div class=":uno: flex min-w-0 items-center gap-2">
					<Show when={props.iconClass}>
						<span
							class=":uno: chatbox-collapsible-icon flex size-5 shrink-0 items-center justify-center text-[var(--text-muted)]"
							title={props.iconLabel}
							aria-label={props.iconLabel}
							role="img"
						>
							<span
								class={`:uno: ${props.iconClass} size-5 shrink-0`}
								aria-hidden="true"
							/>
						</span>
					</Show>
					<div class=":uno: chatbox-collapsible-title truncate font-medium text-[var(--text-normal)]">
						{props.title}
					</div>
				</div>
			}
			headerActions={props.headerActions}
			open={props.open}
			onOpenChange={props.onOpenChange}
		>
			<div
				class={
					appearance() === 'plain'
						? ':uno: chatbox-document-content min-w-0 py-2'
						: ':uno: border-t border-[var(--background-modifier-border)] px-3 py-3'
				}
			>
				{props.children}
			</div>
		</CollapsibleBlock>
	)
}

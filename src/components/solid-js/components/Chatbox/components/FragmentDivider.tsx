import type { ChatTimelineFragmentItem } from '../types'
import { formatFragmentTime } from '../utils'

export function FragmentDivider(props: { item: ChatTimelineFragmentItem }) {
	return (
		<div class="relative py-2">
			<div class="absolute inset-x-0 top-1/2 h-px bg-[var(--background-modifier-border)]" />
			<div class="relative mx-auto w-fit rounded-full border border-[var(--background-modifier-border)] bg-[var(--background-primary)] px-3 py-1 text-xs text-[var(--text-muted)]">
				{formatFragmentTime(props.item.createdAt)}
			</div>
		</div>
	)
}

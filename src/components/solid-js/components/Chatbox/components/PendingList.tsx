import { For, Show } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export function PendingList(props: {
	pendingMessages: ChatboxProps['pendingMessages']
}) {
	return (
		<Show when={props.pendingMessages.length > 0}>
			<div class="rounded-3 border border-dashed border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] p-3">
				<div class="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
					{t('chatbox.ui.labels.pendingMessages')}
				</div>
				<div class="mt-2 flex flex-col gap-2">
					<For each={props.pendingMessages}>
						{(message) => (
							<div class="rounded-2 bg-[var(--background-secondary)] p-3 text-sm text-[var(--text-normal)] whitespace-pre-wrap break-words select-text">
								{message.text}
							</div>
						)}
					</For>
				</div>
			</div>
		</Show>
	)
}

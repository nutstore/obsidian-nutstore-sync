import { For, Show } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { ContextArea } from './ContextArea'

export function PendingList(props: { pending: ChatboxProps['pending'] }) {
	return (
		<Show when={props.pending.length > 0}>
			<div class="rounded-3 border border-dashed border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] p-3">
				<div class="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
					{t('chatbox.ui.labels.queuedSubmissions')}
				</div>
				<div class="mt-2 flex flex-col gap-2">
					<For each={props.pending}>
						{(submission) => (
							<div class="rounded-2 bg-[var(--background-secondary)] p-3 text-sm text-[var(--text-normal)] whitespace-pre-wrap break-words select-text">
								<Show when={submission.userContext.length > 0}>
									<ContextArea items={submission.userContext} />
								</Show>
								<Show when={submission.text.trim().length > 0}>
									<div>{submission.text}</div>
								</Show>
							</div>
						)}
					</For>
				</div>
			</div>
		</Show>
	)
}

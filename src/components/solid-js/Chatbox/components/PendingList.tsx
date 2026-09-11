import { For, Show } from 'solid-js'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '../../i18n'
import { ContextArea } from './ContextArea'

export function PendingList(props: { pending: ChatboxProps['pending'] }) {
	return (
		<Show when={props.pending.length > 0}>
			<div class="chatbox-pending">
				<div class="chatbox-pending-heading" role="status">
					<span class=":uno: i-lucide-list-start size-3.5" aria-hidden="true" />
					<span>{t('chatbox.ui.labels.queuedSubmissions')}</span>
					<span class="chatbox-pending-count">{props.pending.length}</span>
				</div>
				<ol class="chatbox-pending-items">
					<For each={props.pending}>
						{(submission) => (
							<li class="chatbox-pending-item">
								<Show when={submission.userContext.length > 0}>
									<ContextArea items={submission.userContext} />
								</Show>
								<Show when={submission.text.trim().length > 0}>
									<div class="chatbox-pending-text">{submission.text}</div>
								</Show>
							</li>
						)}
					</For>
				</ol>
			</div>
		</Show>
	)
}

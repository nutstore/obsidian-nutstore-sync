import { For, Show } from 'solid-js'
import type { ChatDisplayToolCallBlock, ChatTodoStatus } from '~/ai/chat/types'
import { t } from '../../../i18n'
import { timingDuration, toolStatusVisual } from '../tool-call-status'

function statusIconClass(status: ChatTodoStatus) {
	switch (status) {
		case 'completed':
			return ':uno: i-lucide-circle-check-big text-[var(--color-green)]'
		case 'in_progress':
			return ':uno: i-lucide-loader-circle animate-spin text-[var(--text-muted)]'
		case 'cancelled':
			return ':uno: i-lucide-circle-x text-[var(--text-faint)]'
		case 'pending':
		default:
			return ':uno: i-lucide-circle text-[var(--text-muted)]'
	}
}

export function TodoListBlock(props: {
	block: ChatDisplayToolCallBlock
	now: number
}) {
	const todos = () => props.block.todos ?? []
	const isEmpty = () => todos().length === 0
	const visual = () => toolStatusVisual(props.block.toolCall)

	return (
		<div class=":uno: rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)]">
			<div class=":uno: flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-muted)]">
				<span
					class=":uno: flex size-5 shrink-0 items-center justify-center text-[var(--text-muted)]"
					title={visual().label}
					aria-label={visual().label}
					role="img"
				>
					<span
						class={`:uno: ${visual().iconClass} size-5 shrink-0`}
						aria-hidden="true"
					/>
				</span>
				<div class=":uno: truncate font-medium text-[var(--text-normal)]">
					{isEmpty()
						? t('chatbox.ui.states.todoEmpty')
						: t('chatbox.ui.labels.todoList')}
					<Show when={timingDuration(props.block.timing, props.now)}>
						{(duration) => (
							<span class=":uno: font-normal text-[var(--text-muted)]">
								{' '}
								· {duration()}
							</span>
						)}
					</Show>
				</div>
				<Show when={!isEmpty()}>
					<span class=":uno: ml-auto shrink-0 rounded-full bg-[var(--background-modifier-border)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--text-muted)]">
						{todos().length}
					</span>
				</Show>
			</div>
			<Show when={!isEmpty()}>
				<div class=":uno: border-t border-[var(--background-modifier-border)] px-2 py-1.5">
					<ul class=":uno: m-0 flex flex-col gap-0.5 list-none p-0">
						<For each={todos()}>
							{(todo) => (
								<li class=":uno: flex items-start gap-1.5 rounded-2 px-1.5 py-1 text-xs leading-5">
									<span
										class={`:uno: ${statusIconClass(todo.status)} mt-0.5 size-4 shrink-0`}
										aria-hidden="true"
									/>
									<span
										class={[
											':uno: min-w-0 flex-1 break-words',
											todo.status === 'cancelled'
												? ':uno: text-[var(--text-faint)] line-through'
												: ':uno: text-[var(--text-normal)]',
										].join(' ')}
									>
										{todo.content}
									</span>
								</li>
							)}
						</For>
					</ul>
				</div>
			</Show>
		</div>
	)
}

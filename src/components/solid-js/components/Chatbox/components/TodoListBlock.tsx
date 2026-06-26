import { For, Show } from 'solid-js'
import type { ChatDisplayToolCallBlock, ChatTodoStatus } from '~/ai/chat/types'
import { t } from '../../../i18n'

function statusIconClass(status: ChatTodoStatus) {
	switch (status) {
		case 'completed':
			return 'i-lucide-circle-check-big text-[var(--color-green)]'
		case 'in_progress':
			return 'i-lucide-loader-circle animate-spin text-[var(--text-muted)]'
		case 'cancelled':
			return 'i-lucide-circle-x text-[var(--text-faint)]'
		case 'pending':
		default:
			return 'i-lucide-circle text-[var(--text-muted)]'
	}
}

export function TodoListBlock(props: { block: ChatDisplayToolCallBlock }) {
	const todos = () => props.block.toolMessage?.todos ?? []
	const isEmpty = () => todos().length === 0

	return (
		<div class="rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)]">
			<div class="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-muted)]">
				<span class="flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-muted)]">
					<span class="i-lucide-list-checks size-3.5 shrink-0" />
				</span>
				<div class="truncate font-medium text-[var(--text-normal)]">
					{isEmpty()
						? t('chatbox.ui.states.todoEmpty')
						: t('chatbox.ui.labels.todoList')}
				</div>
				<Show when={!isEmpty()}>
					<span class="ml-auto shrink-0 rounded-full bg-[var(--background-modifier-border)] px-1.5 py-0.5 text-[10px] leading-none text-[var(--text-muted)]">
						{todos().length}
					</span>
				</Show>
			</div>
			<Show when={!isEmpty()}>
				<div class="border-t border-[var(--background-modifier-border)] px-2 py-1.5">
					<ul class="m-0 flex flex-col gap-0.5 list-none p-0">
						<For each={todos()}>
							{(todo) => (
								<li class="flex items-start gap-1.5 rounded-2 px-1.5 py-1 text-xs leading-5">
									<span
										class={`${statusIconClass(todo.status)} mt-0.5 size-4 shrink-0`}
										aria-hidden="true"
									/>
									<span
										class={`min-w-0 flex-1 break-words ${todo.status === 'cancelled' ? 'text-[var(--text-faint)] line-through' : 'text-[var(--text-normal)]'}`}
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

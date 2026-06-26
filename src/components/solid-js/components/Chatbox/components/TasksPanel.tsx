import { For, Show } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { TaskCard } from './TaskCard'

export function TasksPanel(props: {
	currentSessionTasks: ChatboxProps['currentSessionTasks']
	otherSessionTasks: ChatboxProps['otherSessionTasks']
	onCancelTask?: ChatboxProps['onCancelTask']
	onClose: () => void
}) {
	return (
		<div class="flex h-full w-[22rem] shrink-0 flex-col border-l border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)]">
			<div class="flex items-center justify-between border-b border-[var(--background-modifier-border)] px-3 py-3">
				<div class="text-sm font-semibold">{t('chatbox.ui.labels.tasks')}</div>
				<button type="button" onClick={() => props.onClose()}>
					{t('chatbox.ui.actions.closeTasks')}
				</button>
			</div>
			<div class="flex-1 overflow-y-auto px-3 py-3">
				<div class="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
					{t('chatbox.ui.labels.currentSession')}
				</div>
				<div class="mt-2 flex flex-col gap-3">
					<Show
						when={props.currentSessionTasks.length > 0}
						fallback={
							<div class="rounded-3 border border-dashed border-[var(--background-modifier-border)] px-3 py-4 text-sm text-[var(--text-muted)]">
								{t('chatbox.ui.states.noTasks')}
							</div>
						}
					>
						<For each={props.currentSessionTasks}>
							{(task) => (
								<TaskCard
									task={task}
									onCancelTask={props.onCancelTask}
									compact
								/>
							)}
						</For>
					</Show>
				</div>
				<Show when={props.otherSessionTasks.length > 0}>
					<div class="mt-6 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
						{t('chatbox.ui.labels.otherSessions')}
					</div>
					<div class="mt-2 flex flex-col gap-3">
						<For each={props.otherSessionTasks}>
							{(task) => <TaskCard task={task} compact />}
						</For>
					</div>
				</Show>
			</div>
		</div>
	)
}

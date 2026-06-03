import { Show } from 'solid-js'
import { t } from '../i18n'
import type { ChatTaskRecord, ChatboxProps } from '../types'
import { formatDuration, formatTime, statusClass, statusLabel } from '../utils'

export function TaskCard(props: {
	task: ChatTaskRecord
	onCancelTask?: ChatboxProps['onCancelTask']
	compact?: boolean
}) {
	const duration = () => formatDuration(props.task)
	const detail = () => {
		switch (props.task.status) {
			case 'completed':
				return props.task.summary
			case 'failed':
				return props.task.summary || props.task.error
			case 'cancelled':
				return props.task.summary
			default:
				return ''
		}
	}
	const sourceCount = () =>
		props.task.status === 'completed'
			? props.task.sourceCount
			: props.task.status === 'failed'
				? props.task.sourceCount
				: undefined

	return (
		<div
			class={`rounded-3 border p-3 ${
				props.task.status === 'failed'
					? 'border-[var(--text-error)] bg-[var(--background-primary-alt)]'
					: 'border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)]'
			}`}
		>
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0 flex-1">
					<div class="font-medium text-[var(--text-normal)] truncate">
						{props.task.title}
					</div>
					<div class="mt-1 text-xs text-[var(--text-muted)] break-words">
						{props.task.prompt}
					</div>
				</div>
				<span
					class={`shrink-0 rounded-full px-2 py-1 text-xs ${statusClass(props.task.status)}`}
				>
					{statusLabel(props.task.status)}
				</span>
			</div>
			<div class="mt-3 flex flex-wrap gap-2 text-xs text-[var(--text-muted)]">
				<span class="rounded-full bg-[var(--background-secondary)] px-2 py-1">
					{t('depth')}: {props.task.depth}/{props.task.maxDepth}
				</span>
				<Show when={duration()}>
					<span class="rounded-full bg-[var(--background-secondary)] px-2 py-1">
						{duration()}
					</span>
				</Show>
				<Show when={typeof sourceCount() === 'number'}>
					<span class="rounded-full bg-[var(--background-secondary)] px-2 py-1">
						{t('sources')}: {sourceCount()}
					</span>
				</Show>
			</div>
			<Show when={detail()}>
				<div class="mt-3 rounded-2 bg-[var(--background-secondary)] p-3 text-sm leading-6 text-[var(--text-normal)] whitespace-pre-wrap break-words">
					{detail()}
				</div>
			</Show>
			<Show when={!props.compact}>
				<div class="mt-3 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
					<div>
						{formatTime(props.task.createdAt)}
						<Show when={'finishedAt' in props.task && props.task.finishedAt}>
							{` · ${formatTime((props.task as Extract<ChatTaskRecord, { finishedAt: number }>).finishedAt)}`}
						</Show>
					</div>
					<Show when={props.task.status === 'running' && props.onCancelTask}>
						<button
							type="button"
							onClick={() => props.onCancelTask?.(props.task.id)}
						>
							{t('cancelTask')}
						</button>
					</Show>
				</div>
			</Show>
		</div>
	)
}

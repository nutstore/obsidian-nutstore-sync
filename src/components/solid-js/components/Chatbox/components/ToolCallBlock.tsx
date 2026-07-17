import { Show } from 'solid-js'
import type { JSX } from 'solid-js'

import type { ChatDisplayToolCallBlock } from '~/ai/chat/types'
import { t } from '../../../i18n'
import { formatToolResult } from '../utils'

function taskIdFromOutput(output: unknown) {
	if (!output || typeof output !== 'object' || Array.isArray(output)) return
	const taskId = (output as { taskId?: unknown }).taskId
	return typeof taskId === 'string' ? taskId : undefined
}

export function ToolCallBlock(props: {
	block: ChatDisplayToolCallBlock
	onOpenSubagent?: (agentId: string) => void
}) {
	return (
		<Show
			when={props.block.toolCall.toolName === 'task'}
			fallback={<GenericToolCallBlock block={props.block} />}
		>
			<TaskToolCallBlock
				block={props.block}
				onOpenSubagent={props.onOpenSubagent}
			/>
		</Show>
	)
}

function CollapsibleToolCallBlock(props: {
	title: string
	iconClass: string
	params: unknown
	result?: string
	headerActions?: JSX.Element
}) {
	return (
		<details class="group rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)]">
			<summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs text-[var(--text-muted)] marker:hidden">
				<div class="flex min-w-0 items-center gap-2">
					<span class="flex size-6 p-1 shrink-0 items-center justify-center rounded-full border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-muted)]">
						<span class={`${props.iconClass} size-4 shrink-0`} />
					</span>
					<div class="truncate font-medium text-[var(--text-normal)]">
						{props.title}
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					{props.headerActions}
					<span class="i-lucide-chevron-down size-4 shrink-0 transition-transform group-open:rotate-180" />
				</div>
			</summary>
			<div class="border-t border-[var(--background-modifier-border)] px-3 py-3">
				<div class="text-xs text-[var(--text-muted)]">
					{t('chatbox.ui.labels.params')}
				</div>
				<pre class="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-2 bg-[var(--background-primary)] p-2 text-xs leading-5">
					{JSON.stringify(props.params ?? {}, null, 2)}
				</pre>
				<Show when={props.result?.trim()}>
					<div class="mt-3 text-xs text-[var(--text-muted)]">
						{t('chatbox.ui.labels.result')}
					</div>
					<pre class="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-2 bg-[var(--background-primary)] p-2 text-xs leading-5">
						{props.result}
					</pre>
				</Show>
			</div>
		</details>
	)
}

function TaskToolCallBlock(props: {
	block: ChatDisplayToolCallBlock
	onOpenSubagent?: (agentId: string) => void
}) {
	const toolCall = () => props.block.toolCall
	const taskId = () =>
		toolCall().state === 'output-available'
			? taskIdFromOutput(toolCall().output)
			: undefined
	const subagentType = () =>
		String(
			(toolCall().input as { subagent_type?: unknown })?.subagent_type ??
				'unknown',
		)

	return (
		<CollapsibleToolCallBlock
			title={`task · ${subagentType()}`}
			iconClass="i-lucide-bot"
			params={toolCall().input}
			result={formatToolResult(toolCall())}
			headerActions={
				<button
					type="button"
					class="flex size-6 items-center justify-center rounded-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--background-modifier-border)] hover:text-[var(--text-normal)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
					disabled={!taskId()}
					title={t('chatbox.ui.dialogs.subagentTimeline.title')}
					aria-label={t('chatbox.ui.dialogs.subagentTimeline.title')}
					onClick={(event) => {
						event.stopPropagation()
						event.preventDefault()
						const id = taskId()
						if (id) props.onOpenSubagent?.(id)
					}}
				>
					<span class="i-lucide-panel-top-open size-4 shrink-0" />
				</button>
			}
		/>
	)
}

function GenericToolCallBlock(props: { block: ChatDisplayToolCallBlock }) {
	return (
		<CollapsibleToolCallBlock
			title={props.block.toolCall.toolName}
			iconClass="i-lucide-hammer"
			params={props.block.toolCall.input}
			result={formatToolResult(props.block.toolCall)}
		/>
	)
}

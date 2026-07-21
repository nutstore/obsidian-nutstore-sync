import { Show } from 'solid-js'
import type { JSX } from 'solid-js'

import type { ChatDisplayToolCallBlock } from '~/ai/chat/types'
import type { ChatAgentView } from '~/ai/chat/ui/types'
import { t } from '../../../i18n'
import { formatDuration, formatToolResult } from '../utils'
import {
	cancelledVisual,
	failedVisual,
	runningVisual,
	successVisual,
	timingDuration,
	toolStatusVisual,
	waitingVisual,
} from '../tool-call-status'
import { TitledCollapsibleBlock } from './CollapsibleBlock'
import { FileChangesBlock } from './FileChangesBlock'

function taskIdFromOutput(output: unknown) {
	if (!output || typeof output !== 'object' || Array.isArray(output)) return
	const taskId = (output as { taskId?: unknown }).taskId
	return typeof taskId === 'string' ? taskId : undefined
}

export function ToolCallBlock(props: {
	block: ChatDisplayToolCallBlock
	now: number
	getSubagent?: (agentId: string) => ChatAgentView | undefined
	onOpenSubagent?: (agentId: string) => void
	onOpenFileChange?: (vaultPath: string, line?: number) => Promise<void> | void
}) {
	return (
		<Show
			when={props.block.toolCall.toolName === 'task'}
			fallback={
				<GenericToolCallBlock
					block={props.block}
					now={props.now}
					onOpenFileChange={props.onOpenFileChange}
				/>
			}
		>
			<TaskToolCallBlock
				block={props.block}
				now={props.now}
				getSubagent={props.getSubagent}
				onOpenSubagent={props.onOpenSubagent}
				onOpenFileChange={props.onOpenFileChange}
			/>
		</Show>
	)
}

function CollapsibleToolCallBlock(props: {
	title: JSX.Element
	iconClass: string
	iconLabel: string
	params: unknown
	result?: string
	fileChanges?: ChatDisplayToolCallBlock['fileChanges']
	onOpenFileChange?: (vaultPath: string, line?: number) => Promise<void> | void
	headerActions?: JSX.Element
}) {
	return (
		<>
			<TitledCollapsibleBlock
				title={props.title}
				iconClass={props.iconClass}
				iconLabel={props.iconLabel}
				headerActions={props.headerActions}
			>
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
			</TitledCollapsibleBlock>
			<FileChangesBlock
				changes={props.fileChanges}
				onOpenFile={props.onOpenFileChange}
			/>
		</>
	)
}

function TaskToolCallBlock(props: {
	block: ChatDisplayToolCallBlock
	now: number
	getSubagent?: (agentId: string) => ChatAgentView | undefined
	onOpenSubagent?: (agentId: string) => void
	onOpenFileChange?: (vaultPath: string, line?: number) => Promise<void> | void
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
	const subagent = () => {
		const id = taskId()
		return id ? props.getSubagent?.(id) : undefined
	}
	const visual = () => {
		const agent = subagent()
		return agent
			? agentStatusVisual(agent.status)
			: toolStatusVisual(toolCall())
	}
	const duration = () => {
		const agent = subagent()
		if (!agent) return timingDuration(props.block.timing, props.now)
		const startedAt =
			agent.status === 'queued'
				? agent.createdAt
				: (agent.startedAt ?? agent.createdAt)
		return formatDuration((agent.finishedAt ?? props.now) - startedAt)
	}

	return (
		<CollapsibleToolCallBlock
			title={
				<ToolTitle title={`task · ${subagentType()}`} duration={duration()} />
			}
			iconClass={visual().iconClass}
			iconLabel={visual().label}
			params={toolCall().input}
			result={formatToolResult(toolCall())}
			fileChanges={props.block.fileChanges}
			onOpenFileChange={props.onOpenFileChange}
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

function GenericToolCallBlock(props: {
	block: ChatDisplayToolCallBlock
	now: number
	onOpenFileChange?: (vaultPath: string, line?: number) => Promise<void> | void
}) {
	const visual = () => toolStatusVisual(props.block.toolCall)
	return (
		<CollapsibleToolCallBlock
			title={
				<ToolTitle
					title={props.block.toolCall.toolName}
					duration={timingDuration(props.block.timing, props.now)}
				/>
			}
			iconClass={visual().iconClass}
			iconLabel={visual().label}
			params={props.block.toolCall.input}
			result={formatToolResult(props.block.toolCall)}
			fileChanges={props.block.fileChanges}
			onOpenFileChange={props.onOpenFileChange}
		/>
	)
}

function ToolTitle(props: { title: string; duration?: string }) {
	return (
		<span>
			{props.title}
			<Show when={props.duration}>
				<span class="font-normal text-[var(--text-muted)]">
					{' '}
					· {props.duration}
				</span>
			</Show>
		</span>
	)
}

function agentStatusVisual(status: ChatAgentView['status']) {
	switch (status) {
		case 'queued':
			return waitingVisual(
				t('chatbox.ui.states.taskQueued'),
				'i-lucide-clock-3',
			)
		case 'running':
			return runningVisual()
		case 'idle':
			return waitingVisual(
				t('chatbox.ui.states.taskWaiting'),
				'i-lucide-hourglass',
			)
		case 'completed':
			return successVisual()
		case 'failed':
			return failedVisual()
		case 'cancelled':
			return cancelledVisual(t('chatbox.ui.states.cancelled'))
	}
}

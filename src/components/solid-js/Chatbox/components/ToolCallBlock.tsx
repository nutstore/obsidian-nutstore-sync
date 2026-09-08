import type { JSX } from 'solid-js'
import { Match, Show, Switch, createSignal } from 'solid-js'

import type { ChatDisplayToolCallBlock } from '~/ai/chat/types'
import type { ChatAgentView, ChatboxProps } from '~/ai/chat/ui/types'
import { t } from '../../i18n'
import {
	cancelledVisual,
	failedVisual,
	runningVisual,
	successVisual,
	timingDuration,
	toolStatusVisual,
	waitingVisual,
} from '../tool-call-status'
import {
	formatDuration,
	formatToolDetailsMarkdown,
	formatToolResult,
	toolCallDisplayTitle,
	toolCallPurpose,
} from '../utils'
import { TitledCollapsibleBlock } from './CollapsibleBlock'
import { FileChangesBlock } from './FileChangesBlock'
import { MarkdownContent } from './MarkdownContent'
import { TodoListBlock } from './TodoListBlock'

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
	onResolveResourceDataUrl?: ChatboxProps['onResolveResourceDataUrl']
	renderMarkdown?: ChatboxProps['renderMarkdown']
}) {
	const viewImageOutput = () => {
		const toolCall = props.block.toolCall
		if (
			toolCall.toolName !== 'view_image' ||
			toolCall.state !== 'output-available'
		) {
			return undefined
		}
		const output = toolCall.output
		if (!output || typeof output !== 'object' || Array.isArray(output)) return
		const path = (output as { path?: unknown }).path
		const mediaType = (output as { mediaType?: unknown }).mediaType
		return typeof path === 'string' && typeof mediaType === 'string'
			? { path, mediaType }
			: undefined
	}

	return (
		<Switch
			fallback={
				<GenericToolCallBlock
					block={props.block}
					now={props.now}
					onOpenFileChange={props.onOpenFileChange}
					renderMarkdown={props.renderMarkdown}
				/>
			}
		>
			<Match
				when={
					props.block.toolCall.toolName === 'todowrite' && props.block.todos
				}
			>
				<TodoListBlock block={props.block} now={props.now} />
			</Match>
			<Match when={viewImageOutput()}>
				{(output) => (
					<ViewImageToolCallBlock
						path={output().path}
						mediaType={output().mediaType}
						onResolveDataUrl={props.onResolveResourceDataUrl}
						visual={toolStatusVisual(props.block.toolCall)}
					/>
				)}
			</Match>
			<Match when={props.block.toolCall.toolName === 'task'}>
				<TaskToolCallBlock
					block={props.block}
					now={props.now}
					getSubagent={props.getSubagent}
					onOpenSubagent={props.onOpenSubagent}
					onOpenFileChange={props.onOpenFileChange}
					renderMarkdown={props.renderMarkdown}
				/>
			</Match>
			<Match
				when={
					props.block.toolCall.toolName === 'bash' ||
					props.block.toolCall.toolName === 'apply_patch'
				}
			>
				<PurposeToolCallBlock
					block={props.block}
					now={props.now}
					onOpenFileChange={props.onOpenFileChange}
					renderMarkdown={props.renderMarkdown}
				/>
			</Match>
		</Switch>
	)
}

function ViewImageToolCallBlock(props: {
	path: string
	mediaType: string
	onResolveDataUrl?: ChatboxProps['onResolveResourceDataUrl']
	visual: ReturnType<typeof toolStatusVisual>
}) {
	const [dimensions, setDimensions] = createSignal<string>()
	const [open, setOpen] = createSignal(false)
	const [src, setSrc] = createSignal<string>()
	const [loading, setLoading] = createSignal(false)
	const [loaded, setLoaded] = createSignal(false)

	async function loadImage() {
		if (loaded()) return
		setLoaded(true)
		if (!props.onResolveDataUrl) return
		setLoading(true)
		try {
			setSrc(await props.onResolveDataUrl(props.path, props.mediaType))
		} catch {
			setSrc(undefined)
		} finally {
			setLoading(false)
		}
	}

	function handleOpenChange(value: boolean) {
		setOpen(value)
		if (value) void loadImage()
	}

	return (
		<TitledCollapsibleBlock
			title={
				<span>
					Image ({props.path})
					<Show when={dimensions()}>
						<span class=":uno: font-normal text-[var(--text-muted)]">
							{'('}
							{dimensions()}
							{')'}
						</span>
					</Show>
				</span>
			}
			iconClass={props.visual.iconClass}
			iconLabel={props.visual.label}
			open={open()}
			onOpenChange={handleOpenChange}
		>
			<Show
				when={src()}
				fallback={
					<Show
						when={loading()}
						fallback={
							<div class=":uno: text-xs text-[var(--text-muted)]">
								Image preview unavailable.
							</div>
						}
					>
						<div
							class=":uno: h-40 animate-pulse rounded-2 bg-[var(--background-modifier-hover)]"
							aria-label="Loading image preview"
							role="status"
						/>
					</Show>
				}
			>
				{(src) => (
					<img
						class=":uno: max-h-100 max-w-full rounded-2 border border-[var(--background-modifier-border)] object-contain"
						src={src()}
						alt={props.path}
						onLoad={(event) => {
							const image = event.currentTarget
							setDimensions(`${image.naturalWidth}x${image.naturalHeight}`)
						}}
					/>
				)}
			</Show>
		</TitledCollapsibleBlock>
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
	renderMarkdown?: ChatboxProps['renderMarkdown']
}) {
	return (
		<>
			<TitledCollapsibleBlock
				title={props.title}
				iconClass={props.iconClass}
				iconLabel={props.iconLabel}
				headerActions={props.headerActions}
			>
				<MarkdownContent
					markdown={formatToolDetailsMarkdown(props.params, props.result)}
					renderMarkdown={props.renderMarkdown}
					compact
					details
				/>
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
	renderMarkdown?: ChatboxProps['renderMarkdown']
}) {
	const toolCall = () => props.block.toolCall
	const taskId = () =>
		toolCall().state === 'output-available'
			? taskIdFromOutput(toolCall().output)
			: undefined
	const subagentType = () => {
		const value = (toolCall().input as { subagent_type?: unknown })
			?.subagent_type
		return typeof value === 'string' ? value : 'unknown'
	}
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
			renderMarkdown={props.renderMarkdown}
			headerActions={
				<button
					type="button"
					class=":uno: flex size-6 items-center justify-center rounded-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--background-modifier-border)] hover:text-[var(--text-normal)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--text-muted)]"
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
					<span class=":uno: i-lucide-panel-top-open size-4 shrink-0" />
				</button>
			}
		/>
	)
}

function PurposeToolCallBlock(props: {
	block: ChatDisplayToolCallBlock
	now: number
	onOpenFileChange?: (vaultPath: string, line?: number) => Promise<void> | void
	renderMarkdown?: ChatboxProps['renderMarkdown']
}) {
	const visual = () => toolStatusVisual(props.block.toolCall)
	const hasPurpose = () => toolCallPurpose(props.block.toolCall) !== undefined
	return (
		<CollapsibleToolCallBlock
			title={
				<ToolTitle
					title={toolCallDisplayTitle(props.block.toolCall)}
					duration={timingDuration(props.block.timing, props.now)}
				/>
			}
			iconClass={visual().iconClass}
			iconLabel={visual().label}
			params={hasPurpose() ? undefined : props.block.toolCall.input}
			result={formatToolResult(props.block.toolCall)}
			fileChanges={props.block.fileChanges}
			onOpenFileChange={props.onOpenFileChange}
			renderMarkdown={props.renderMarkdown}
		/>
	)
}

function GenericToolCallBlock(props: {
	block: ChatDisplayToolCallBlock
	now: number
	onOpenFileChange?: (vaultPath: string, line?: number) => Promise<void> | void
	renderMarkdown?: ChatboxProps['renderMarkdown']
}) {
	const visual = () => toolStatusVisual(props.block.toolCall)
	return (
		<CollapsibleToolCallBlock
			title={
				<ToolTitle
					title={toolCallDisplayTitle(props.block.toolCall)}
					duration={timingDuration(props.block.timing, props.now)}
				/>
			}
			iconClass={visual().iconClass}
			iconLabel={visual().label}
			params={props.block.toolCall.input}
			result={formatToolResult(props.block.toolCall)}
			fileChanges={props.block.fileChanges}
			onOpenFileChange={props.onOpenFileChange}
			renderMarkdown={props.renderMarkdown}
		/>
	)
}

function ToolTitle(props: { title: string; duration?: string }) {
	return (
		<span>
			{props.title}
			<Show when={props.duration}>
				<span class=":uno: font-normal text-[var(--text-muted)]">
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
				':uno: i-lucide-clock-3',
			)
		case 'running':
			return runningVisual()
		case 'idle':
			return waitingVisual(
				t('chatbox.ui.states.taskWaiting'),
				':uno: i-lucide-hourglass',
			)
		case 'completed':
			return successVisual()
		case 'failed':
			return failedVisual()
		case 'cancelled':
			return cancelledVisual(t('chatbox.ui.states.cancelled'))
	}
}

import { For, Match, Show, Switch } from 'solid-js'
import type { ChatDisplayBlock } from '~/ai/chat/types'
import type {
	ChatAgentView,
	ChatTimelineMessageItem,
	ChatboxProps,
} from '~/ai/chat/ui/types'
import { t } from '../../i18n'
import {
	formatSystemNotificationMarkdown,
	formatTime,
	formatToolDetailsMarkdown,
	formatToolResult,
	formatUsage,
} from '../utils'
import { ContentBlock } from './ContentBlock'
import { ContextArea } from './ContextArea'
import { CopyButton } from './CopyButton'
import { ReasoningBlock } from './ReasoningBlock'
import { SystemNotificationBlock } from './SystemNotificationBlock'
import { ToolCallBlock } from './ToolCallBlock'

function copyTextForContentBlock(
	block: Extract<ChatDisplayBlock, { kind: 'content' }>,
) {
	return block.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
		.trim()
}

function copyTextForToolCallBlock(
	block: Extract<ChatDisplayBlock, { kind: 'tool-call' }>,
) {
	const todos = block.todos
	if (block.toolCall.toolName === 'todowrite' && todos) {
		const lines = [`${t('chatbox.ui.labels.todoList')}:`, '']
		for (const todo of todos) {
			const checked =
				todo.status === 'completed'
					? 'x'
					: todo.status === 'cancelled'
						? '-'
						: ' '
			lines.push(`- [${checked}] ${todo.content}`)
		}
		if (todos.length === 0) {
			lines.push(`- ${t('chatbox.ui.states.todoEmpty')}`)
		}
		return lines.join('\n')
	}

	return [
		`${t('chatbox.ui.labels.toolCall')}: ${block.toolCall.toolName}`,
		'',
		formatToolDetailsMarkdown(
			block.toolCall.input,
			formatToolResult(block.toolCall),
		),
	].join('\n')
}

function copyTextForSystemNotificationBlock(
	block: Extract<ChatDisplayBlock, { kind: 'system-notification' }>,
) {
	return `${t('chatbox.ui.labels.systemNotification')}:\n\n${formatSystemNotificationMarkdown(block.notification)}`
}

function MessageDisplayBlock(props: {
	block: ChatDisplayBlock
	now: number
	renderMarkdown?: ChatboxProps['renderMarkdown']
	streaming?: boolean
	getSubagent?: (agentId: string) => ChatAgentView | undefined
	onOpenSubagent?: (agentId: string) => void
	onOpenFileChange?: ChatboxProps['onOpenFileChange']
	onResolveResourceDataUrl?: ChatboxProps['onResolveResourceDataUrl']
}) {
	const contentBlock = () =>
		props.block.kind === 'content' ? props.block : undefined
	const reasoningBlock = () =>
		props.block.kind === 'reasoning' ? props.block : undefined
	const toolBlock = () =>
		props.block.kind === 'tool-call' ? props.block : undefined
	const systemNotificationBlock = () =>
		props.block.kind === 'system-notification' ? props.block : undefined

	return (
		<Switch>
			<Match when={contentBlock()}>
				{(block) => (
					<ContentBlock
						block={block()}
						renderMarkdown={props.renderMarkdown}
						streaming={props.streaming}
					/>
				)}
			</Match>
			<Match when={reasoningBlock()}>
				{(block) => <ReasoningBlock part={block().part} />}
			</Match>
			<Match when={toolBlock()}>
				{(block) => (
					<ToolCallBlock
						block={block()}
						now={props.now}
						getSubagent={props.getSubagent}
						onOpenSubagent={props.onOpenSubagent}
						onOpenFileChange={props.onOpenFileChange}
						onResolveResourceDataUrl={props.onResolveResourceDataUrl}
						renderMarkdown={props.renderMarkdown}
					/>
				)}
			</Match>
			<Match when={systemNotificationBlock()}>
				{(block) => (
					<SystemNotificationBlock
						block={block()}
						renderMarkdown={props.renderMarkdown}
					/>
				)}
			</Match>
		</Switch>
	)
}

export function MessageCard(props: {
	item: ChatTimelineMessageItem
	now: number
	renderMarkdown?: ChatboxProps['renderMarkdown']
	streaming?: boolean
	onDeleteMessage?: ChatboxProps['onDeleteMessage']
	onRegenerateMessage?: ChatboxProps['onRegenerateMessage']
	onRecallMessage?: ChatboxProps['onRecallMessage']
	getSubagent?: (agentId: string) => ChatAgentView | undefined
	onOpenSubagent?: (agentId: string) => void
	onOpenFileChange?: ChatboxProps['onOpenFileChange']
	onResolveResourceDataUrl?: ChatboxProps['onResolveResourceDataUrl']
}) {
	const usageText = () =>
		formatUsage(
			props.item.message.metadata?.llm?.usage?.inputTokens,
			props.item.message.metadata?.llm?.usage?.outputTokens,
			props.item.message.metadata?.llm?.usage?.totalTokens,
		)
	const isSystemNotification = () =>
		props.item.displayBlocks.length > 0 &&
		props.item.displayBlocks.every(
			(block) => block.kind === 'system-notification',
		)

	const roleLabel = () => {
		if (props.item.message.role === 'assistant') {
			return props.item.message.metadata?.llm?.modelName || 'Assistant'
		}
		if (props.item.message.role === 'user') {
			return 'User'
		}
		return 'Tool'
	}

	const roleIconClass = () => {
		if (props.item.message.role === 'assistant') {
			return ':uno: i-lucide-bot'
		}
		if (props.item.message.role === 'user') {
			return ':uno: i-lucide-circle-user-round'
		}
	}

	const getText = () => {
		return props.item.displayBlocks
			.map((block) => {
				if (block.kind === 'content') return copyTextForContentBlock(block)
				if (block.kind === 'tool-call') return copyTextForToolCallBlock(block)
				if (block.kind === 'system-notification')
					return copyTextForSystemNotificationBlock(block)
				return ''
			})
			.filter(Boolean)
			.join('\n\n')
	}

	return (
		<div
			class={
				props.item.message.metadata?.status === 'error'
					? ':uno: text-[var(--text-error)]'
					: undefined
			}
		>
			<Show when={props.item.showHeader && !isSystemNotification()}>
				<div class=":uno: mb-2 flex items-center justify-between gap-3 px-1 text-xs text-[var(--text-muted)]">
					<div class=":uno: flex items-center gap-1 font-medium text-[var(--text-normal)]">
						<span
							class={`:uno: ${roleIconClass()} size-4 shrink-0`}
							aria-hidden="true"
						/>
						<span>{roleLabel()}</span>
					</div>
					<span>{formatTime(props.item.createdAt)}</span>
				</div>
			</Show>
			<div class=":uno: flex flex-col gap-2">
				<For each={props.item.displayBlocks}>
					{(block) => (
						<MessageDisplayBlock
							block={block}
							now={props.now}
							renderMarkdown={props.renderMarkdown}
							streaming={props.streaming}
							getSubagent={props.getSubagent}
							onOpenSubagent={props.onOpenSubagent}
							onOpenFileChange={props.onOpenFileChange}
							onResolveResourceDataUrl={props.onResolveResourceDataUrl}
						/>
					)}
				</For>
			</div>
			<Show
				when={
					props.item.message.role === 'user' &&
					props.item.message.parts.some(
						(part) => part.type === 'data-user-context',
					)
				}
			>
				<div class=":uno: mt-2">
					<ContextArea
						items={props.item.message.parts.flatMap((part) =>
							part.type === 'data-user-context' ? part.data.items : [],
						)}
					/>
				</div>
			</Show>
			<Show
				when={
					!isSystemNotification() &&
					(props.item.message.role === 'assistant' ||
						props.item.message.role === 'user')
				}
			>
				<div class=":uno: mt-3 flex items-center justify-between gap-2 px-1">
					<div class=":uno: flex items-center gap-0.5">
						<CopyButton getText={getText} />
						<Show when={props.onDeleteMessage}>
							<button
								class=":uno: cursor-pointer p-1 size-6 text-[var(--text-muted)] hover:text-[var(--text-error)] !border-none !bg-transparent !shadow-none"
								type="button"
								title={t('chatbox.ui.actions.deleteMessage')}
								onClick={() => props.onDeleteMessage?.(props.item.message.id)}
							>
								<span
									class=":uno: i-lucide-trash-2 size-3.5 shrink-0"
									aria-hidden="true"
								/>
							</button>
						</Show>
						<Show
							when={props.item.message.role === 'user' && props.onRecallMessage}
						>
							<button
								class=":uno: cursor-pointer p-1 size-6 text-[var(--text-muted)] hover:text-[var(--text-normal)] !border-none !bg-transparent !shadow-none"
								type="button"
								title={t('chatbox.ui.actions.recallMessage')}
								onClick={() => {
									void props.onRecallMessage?.(props.item.message.id)
								}}
							>
								<span
									class=":uno: i-lucide-undo-2 size-3.5 shrink-0"
									aria-hidden="true"
								/>
							</button>
						</Show>
						<Show
							when={
								props.item.message.role === 'assistant' &&
								props.onRegenerateMessage
							}
						>
							<button
								class=":uno: cursor-pointer p-1 size-6 text-[var(--text-muted)] hover:text-[var(--text-normal)] !border-none !bg-transparent !shadow-none"
								type="button"
								title={t('chatbox.ui.actions.regenerateMessage')}
								onClick={() =>
									props.onRegenerateMessage?.(props.item.message.id)
								}
							>
								<span
									class=":uno: i-lucide-refresh-cw size-3.5 shrink-0"
									aria-hidden="true"
								/>
							</button>
						</Show>
					</div>
					<Show when={props.item.message.role === 'assistant' && usageText()}>
						<div class=":uno: text-[10px] text-[var(--text-faint)]">
							{usageText()}
						</div>
					</Show>
				</div>
			</Show>
		</div>
	)
}

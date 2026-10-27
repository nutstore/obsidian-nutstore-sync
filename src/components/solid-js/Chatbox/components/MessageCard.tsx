import { Index, Match, Show, Switch } from 'solid-js'
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
	/** Optional UI slice; actions and copying still use the original message. */
	displayBlocks?: ChatDisplayBlock[]
	now: number
	renderMarkdown?: ChatboxProps['renderMarkdown']
	streaming?: boolean
	process?: boolean
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
			class={[
				'ns-message-card',
				props.item.message.role === 'user'
					? 'ns-message-card--user'
					: props.item.message.role === 'assistant'
						? 'ns-message-card--assistant'
						: 'ns-message-card--tool',
				props.item.message.metadata?.status === 'error'
					? ':uno: text-[var(--text-error)]'
					: '',
			]
				.filter(Boolean)
				.join(' ')}
		>
			<Show
				when={
					!props.process && props.item.showHeader && !isSystemNotification()
				}
			>
				<div class="ns-message-header">
					<div class="ns-message-role-badge">
						<span
							class={`:uno: ${roleIconClass()} size-3.5 shrink-0 ns-message-role-icon`}
							aria-hidden="true"
						/>
						<span class="ns-message-role-name">{roleLabel()}</span>
					</div>
					<span class="ns-message-time">
						{formatTime(props.item.createdAt)}
					</span>
				</div>
			</Show>
			<div class=":uno: flex flex-col gap-[var(--ns-chatbox-block-gap)]">
				<Index each={props.displayBlocks ?? props.item.displayBlocks}>
					{(block) => (
						<MessageDisplayBlock
							block={block()}
							now={props.now}
							renderMarkdown={props.renderMarkdown}
							streaming={props.streaming}
							getSubagent={props.getSubagent}
							onOpenSubagent={props.onOpenSubagent}
							onOpenFileChange={props.onOpenFileChange}
							onResolveResourceDataUrl={props.onResolveResourceDataUrl}
						/>
					)}
				</Index>
			</div>
			<Show
				when={
					props.item.message.role === 'user' &&
					props.item.message.parts.some(
						(part) => part.type === 'data-user-context',
					)
				}
			>
				<div class=":uno: mt-[var(--ns-chatbox-block-gap)]">
					<ContextArea
						items={props.item.message.parts.flatMap((part) =>
							part.type === 'data-user-context' ? part.data.items : [],
						)}
					/>
				</div>
			</Show>
			<Show
				when={
					!props.process &&
					!isSystemNotification() &&
					(props.item.message.role === 'assistant' ||
						props.item.message.role === 'user')
				}
			>
				<div class="ns-message-footer">
					<div class="ns-message-actions">
						<CopyButton getText={getText} />
						<Show when={props.onDeleteMessage}>
							<button
								class="ns-message-action-btn ns-message-action-btn--danger"
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
								class="ns-message-action-btn"
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
								class="ns-message-action-btn"
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
						<div class="ns-message-usage">{usageText()}</div>
					</Show>
				</div>
			</Show>
		</div>
	)
}

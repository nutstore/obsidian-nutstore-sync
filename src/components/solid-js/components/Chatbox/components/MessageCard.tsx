import { For, Show } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatDisplayBlock } from '~/ai/chat/types'
import type { ChatTimelineMessageItem, ChatboxProps } from '~/ai/chat/ui/types'
import { formatTime, formatToolResult, formatUsage } from '../utils'
import { ContentBlock } from './ContentBlock'
import { ContextArea } from './ContextArea'
import { CopyButton } from './CopyButton'
import { ToolCallBlock } from './ToolCallBlock'
import { TodoListBlock } from './TodoListBlock'

function fencedCode(language: string, value: string) {
	const longestBacktickRun = Math.max(
		0,
		...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
	)
	const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
	return `${fence}${language}\n${value}\n${fence}`
}

function stringifyToolInput(input: unknown) {
	try {
		return JSON.stringify(input ?? {}, null, 2)
	} catch {
		return String(input ?? {})
	}
}

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

	const resultText = formatToolResult(block.toolCall).trim()
	const lines = [
		`${t('chatbox.ui.labels.toolCall')}: ${block.toolCall.toolName}`,
		'',
		`${t('chatbox.ui.labels.params')}:`,
		fencedCode('json', stringifyToolInput(block.toolCall.input)),
	]

	if (resultText) {
		lines.push(
			'',
			`${t('chatbox.ui.labels.result')}:`,
			fencedCode('text', resultText),
		)
	}

	return lines.join('\n')
}

function MessageDisplayBlock(props: {
	block: ChatDisplayBlock
	renderMarkdown?: ChatboxProps['renderMarkdown']
	onOpenSubagent?: (agentId: string) => void
}) {
	const contentBlock = () =>
		props.block.kind === 'content' ? props.block : undefined
	const toolBlock = () =>
		props.block.kind === 'tool-call' ? props.block : undefined

	return (
		<Show
			when={contentBlock()}
			keyed
			fallback={
				<Show when={toolBlock()} keyed>
					{(block) => (
						<Show
							when={block.toolCall.toolName === 'todowrite' && block.todos}
							fallback={
								<ToolCallBlock
									block={block}
									onOpenSubagent={props.onOpenSubagent}
								/>
							}
						>
							<TodoListBlock block={block} />
						</Show>
					)}
				</Show>
			}
		>
			{(block) => (
				<ContentBlock block={block} renderMarkdown={props.renderMarkdown} />
			)}
		</Show>
	)
}

export function MessageCard(props: {
	item: ChatTimelineMessageItem
	renderMarkdown?: ChatboxProps['renderMarkdown']
	onDeleteMessage?: ChatboxProps['onDeleteMessage']
	onRegenerateMessage?: ChatboxProps['onRegenerateMessage']
	onRecallMessage?: ChatboxProps['onRecallMessage']
	onOpenSubagent?: (agentId: string) => void
}) {
	const usageText = () =>
		formatUsage(
			props.item.message.metadata?.llm?.usage?.inputTokens,
			props.item.message.metadata?.llm?.usage?.outputTokens,
			props.item.message.metadata?.llm?.usage?.totalTokens,
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
			return 'i-lucide-bot'
		}
		if (props.item.message.role === 'user') {
			return 'i-lucide-circle-user-round'
		}
	}

	const getText = () => {
		return props.item.displayBlocks
			.map((block) =>
				block.kind === 'content'
					? copyTextForContentBlock(block)
					: copyTextForToolCallBlock(block),
			)
			.filter(Boolean)
			.join('\n\n')
	}

	return (
		<div
			class={`${props.item.message.metadata?.status === 'error' ? 'text-[var(--text-error)]' : ''}`}
		>
			<Show when={props.item.showHeader}>
				<div class="mb-2 flex items-center justify-between gap-3 px-1 text-xs text-[var(--text-muted)]">
					<div class="flex items-center gap-1 font-medium text-[var(--text-normal)]">
						<span
							class={`${roleIconClass()} size-4 shrink-0`}
							aria-hidden="true"
						/>
						<span>{roleLabel()}</span>
					</div>
					<span>{formatTime(props.item.createdAt)}</span>
				</div>
			</Show>
			<div class="flex flex-col gap-2">
				<For each={props.item.displayBlocks}>
					{(block) => (
						<MessageDisplayBlock
							block={block}
							renderMarkdown={props.renderMarkdown}
							onOpenSubagent={props.onOpenSubagent}
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
				<div class="mt-2">
					<ContextArea
						items={props.item.message.parts.flatMap((part) =>
							part.type === 'data-user-context' ? part.data.items : [],
						)}
					/>
				</div>
			</Show>
			<Show
				when={
					props.item.message.role === 'assistant' ||
					props.item.message.role === 'user'
				}
			>
				<div class="mt-3 flex items-center justify-between gap-2 px-1">
					<div class="flex items-center gap-0.5">
						<CopyButton getText={getText} />
						<Show when={props.onDeleteMessage}>
							<button
								class="cursor-pointer p-1 size-6 text-[var(--text-muted)] hover:text-[var(--text-error)] !border-none !bg-transparent !shadow-none"
								type="button"
								title={t('chatbox.ui.actions.deleteMessage')}
								onClick={() => props.onDeleteMessage?.(props.item.message.id)}
							>
								<span
									class="i-lucide-trash-2 size-3.5 shrink-0"
									aria-hidden="true"
								/>
							</button>
						</Show>
						<Show
							when={props.item.message.role === 'user' && props.onRecallMessage}
						>
							<button
								class="cursor-pointer p-1 size-6 text-[var(--text-muted)] hover:text-[var(--text-normal)] !border-none !bg-transparent !shadow-none"
								type="button"
								title={t('chatbox.ui.actions.recallMessage')}
								onClick={() => props.onRecallMessage?.(props.item.message.id)}
							>
								<span
									class="i-lucide-undo-2 size-3.5 shrink-0"
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
								class="cursor-pointer p-1 size-6 text-[var(--text-muted)] hover:text-[var(--text-normal)] !border-none !bg-transparent !shadow-none"
								type="button"
								title={t('chatbox.ui.actions.regenerateMessage')}
								onClick={() =>
									props.onRegenerateMessage?.(props.item.message.id)
								}
							>
								<span
									class="i-lucide-refresh-cw size-3.5 shrink-0"
									aria-hidden="true"
								/>
							</button>
						</Show>
					</div>
					<Show when={props.item.message.role === 'assistant' && usageText()}>
						<div class="text-[10px] text-[var(--text-faint)]">
							{usageText()}
						</div>
					</Show>
				</div>
			</Show>
		</div>
	)
}

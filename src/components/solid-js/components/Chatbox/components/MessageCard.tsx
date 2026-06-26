import { For, Match, Show, Switch } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatDisplayBlock } from '~/ai/chat/types'
import type { ChatTimelineMessageItem, ChatboxProps } from '~/ai/chat/ui/types'
import { formatTime, formatUsage } from '../utils'
import { ContentBlock } from './ContentBlock'
import { ContextArea } from './ContextArea'
import { CopyButton } from './CopyButton'
import { ToolCallBlock, ToolResultBlock } from './ToolCallBlock'
import { TodoListBlock } from './TodoListBlock'

type CopyToolResultPart = {
	type: string
	output?: { type?: string; value?: string }
}

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

function toolResultText(toolMessage?: { message: { content?: unknown } }) {
	const parts = Array.isArray(toolMessage?.message.content)
		? (toolMessage?.message.content as CopyToolResultPart[])
		: []
	return parts
		.filter((part) => part.type === 'tool-result')
		.map((part) =>
			part.output?.type === 'text' ? (part.output.value ?? '') : '',
		)
		.join('\n')
}

function copyTextForContentBlock(
	block: Extract<ChatDisplayBlock, { kind: 'content' }>,
) {
	return block.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text ?? '')
		.join('\n')
		.trim()
}

function copyTextForToolCallBlock(
	block: Extract<ChatDisplayBlock, { kind: 'tool-call' }>,
) {
	const todos = block.toolMessage?.todos
	if (block.toolCall.toolName === 'todowrite' && Array.isArray(todos)) {
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

	const resultText = toolResultText(block.toolMessage).trim()
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

export function MessageCard(props: {
	item: ChatTimelineMessageItem
	renderMarkdown?: ChatboxProps['renderMarkdown']
	onDeleteMessage?: ChatboxProps['onDeleteMessage']
	onRegenerateMessage?: ChatboxProps['onRegenerateMessage']
	onRecallMessage?: ChatboxProps['onRecallMessage']
}) {
	const usageText = () =>
		formatUsage(
			props.item.message.meta?.usage?.inputTokens,
			props.item.message.meta?.usage?.outputTokens,
			props.item.message.meta?.usage?.totalTokens,
		)

	const roleLabel = () => {
		if (props.item.message.message.role === 'assistant') {
			return props.item.message.meta?.modelName || 'Assistant'
		}
		if (props.item.message.message.role === 'user') {
			return 'User'
		}
		return 'Tool'
	}

	const roleIconClass = () => {
		if (props.item.message.message.role === 'assistant') {
			return 'i-lucide-bot'
		}
		if (props.item.message.message.role === 'user') {
			return 'i-lucide-circle-user-round'
		}
	}

	const getText = () => {
		return props.item.displayBlocks
			.map((block) => {
				if (block.kind === 'content') {
					return copyTextForContentBlock(block)
				}
				if (block.kind === 'tool-call') {
					return copyTextForToolCallBlock(block)
				}
				return toolResultText(block.toolMessage).trim()
			})
			.filter(Boolean)
			.join('\n\n')
	}

	return (
		<div
			class={`${props.item.message.isError ? 'text-[var(--text-error)]' : ''}`}
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
					<span>{formatTime(props.item.message.createdAt)}</span>
				</div>
			</Show>
			<div class="flex flex-col gap-2">
				<For each={props.item.displayBlocks}>
					{(block) => (
						<Switch>
							<Match when={block.kind === 'content'}>
								<ContentBlock
									block={
										block as Extract<ChatDisplayBlock, { kind: 'content' }>
									}
									renderMarkdown={props.renderMarkdown}
								/>
							</Match>
							<Match when={block.kind === 'tool-call'}>
								<Show
									when={
										(block as Extract<ChatDisplayBlock, { kind: 'tool-call' }>)
											.toolCall.toolName === 'todowrite' &&
										Array.isArray(
											(
												block as Extract<
													ChatDisplayBlock,
													{ kind: 'tool-call' }
												>
											).toolMessage?.todos,
										)
									}
									fallback={
										<ToolCallBlock
											block={
												block as Extract<
													ChatDisplayBlock,
													{ kind: 'tool-call' }
												>
											}
										/>
									}
								>
									<TodoListBlock
										block={
											block as Extract<ChatDisplayBlock, { kind: 'tool-call' }>
										}
									/>
								</Show>
							</Match>
							<Match when={block.kind === 'tool-result'}>
								<ToolResultBlock
									block={
										block as Extract<ChatDisplayBlock, { kind: 'tool-result' }>
									}
								/>
							</Match>
						</Switch>
					)}
				</For>
			</div>
			<Show
				when={
					props.item.message.message.role === 'user' &&
					props.item.message.userContext?.length
				}
			>
				<div class="mt-2">
					<ContextArea items={props.item.message.userContext!} />
				</div>
			</Show>
			<Show
				when={
					props.item.message.message.role === 'assistant' ||
					props.item.message.message.role === 'user'
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
							when={
								props.item.message.message.role === 'user' &&
								props.onRecallMessage
							}
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
								props.item.message.message.role === 'assistant' &&
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
					<Show
						when={
							props.item.message.message.role === 'assistant' && usageText()
						}
					>
						<div class="text-[10px] text-[var(--text-faint)]">
							{usageText()}
						</div>
					</Show>
				</div>
			</Show>
		</div>
	)
}

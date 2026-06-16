import { For, Match, Show, Switch } from 'solid-js'
import type {
	ChatDisplayBlock,
	ChatTimelineMessageItem,
	ChatboxProps,
} from '../types'
import { t } from '../../../i18n'
import { formatTime, formatUsage } from '../utils'
import { CopyButton } from './CopyButton'
import { ContextArea } from './ContextArea'
import { ContentBlock } from './ContentBlock'
import { ToolCallBlock, ToolResultBlock } from './ToolCallBlock'

export function MessageCard(props: {
	item: ChatTimelineMessageItem
	renderMarkdown?: ChatboxProps['renderMarkdown']
	onDeleteMessage?: ChatboxProps['onDeleteMessage']
	onRegenerateMessage?: ChatboxProps['onRegenerateMessage']
	onRecallMessage?: ChatboxProps['onRecallMessage']
}) {
	const content = () => props.item.message.message.content
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

	const getText = () => {
		const parts = (content() ?? []) as Array<{
			type: string
			text?: string
			output?: { type: string; value?: string }
		}>
		if (props.item.message.message.role === 'tool') {
			return parts
				.filter((p) => p.type === 'tool-result')
				.map((p) => (p.output?.type === 'text' ? (p.output.value ?? '') : ''))
				.join('\n')
		}
		return parts
			.filter((p) => p.type === 'text')
			.map((p) => p.text ?? '')
			.join('\n')
	}

	return (
		<div
			class={`${props.item.message.isError ? 'text-[var(--text-error)]' : ''}`}
		>
			<div class="mb-2 flex items-center justify-between gap-3 px-1 text-xs text-[var(--text-muted)]">
				<div class="font-medium text-[var(--text-normal)]">{roleLabel()}</div>
				<span>{formatTime(props.item.message.createdAt)}</span>
			</div>
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
								<ToolCallBlock
									block={
										block as Extract<ChatDisplayBlock, { kind: 'tool-call' }>
									}
								/>
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
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<polyline points="3 6 5 6 21 6" />
									<path d="M19 6l-1 14H6L5 6" />
									<path d="M10 11v6M14 11v6" />
									<path d="M9 6V4h6v2" />
								</svg>
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
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M9 14 4 9l5-5" />
									<path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
								</svg>
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
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
									<path d="M21 3v5h-5" />
									<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
									<path d="M8 16H3v5" />
								</svg>
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

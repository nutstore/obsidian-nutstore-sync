import { For, Match, Show, Switch } from 'solid-js'
import { t } from '../../../i18n'
import type { ChatDisplayBlock } from '~/ai/chat/types'
import type { ChatTimelineMessageItem, ChatboxProps } from '~/ai/chat/ui/types'
import { formatTime, formatUsage } from '../utils'
import { ContentBlock } from './ContentBlock'
import { ContextArea } from './ContextArea'
import { CopyButton } from './CopyButton'
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

	const roleIconClass = () => {
		if (props.item.message.message.role === 'assistant') {
			return 'i-lucide-bot'
		}
		if (props.item.message.message.role === 'user') {
			return 'i-lucide-circle-user-round'
		}
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

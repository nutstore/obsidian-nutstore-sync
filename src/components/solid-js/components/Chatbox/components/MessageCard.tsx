import { Show } from 'solid-js'
import type {
	ChatMessageContentPart,
	ChatTimelineMessageItem,
	ChatboxProps,
} from '../types'
import { t } from '../i18n'
import { formatTime, formatUsage } from '../utils'
import { CopyButton } from './CopyButton'
import { ContentParts } from './ContentParts'
import { ContextArea } from './ContextArea'

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
		if (props.item.message.message.role === 'tool') {
			const firstPart = Array.isArray(props.item.message.message.content)
				? (
						props.item.message.message.content as Array<{
							type: string
							toolName?: string
						}>
					)[0]
				: undefined
			const toolName =
				firstPart?.type === 'tool-result' ? firstPart.toolName : undefined
			return `Tool: ${toolName || t('tool')}`
		}
		if (props.item.message.message.role === 'assistant') {
			return props.item.message.meta?.modelName || 'Assistant'
		}
		if (props.item.message.message.role === 'user') {
			return 'User'
		}
		return 'System'
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
		<Show
			when={props.item.message.message.role !== 'tool'}
			fallback={
				<details
					class={`rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] p-3 ${
						props.item.message.isError ? 'border-[var(--text-error)]' : ''
					}`}
				>
					<summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-xs text-[var(--text-muted)] marker:hidden">
						<div class="font-medium text-[var(--text-normal)]">
							{roleLabel()}
						</div>
						<div class="flex items-center gap-1">
							<span>{formatTime(props.item.message.createdAt)}</span>
							<span onClick={(e) => e.stopPropagation()}>
								<CopyButton getText={getText} />
							</span>
							<Show when={props.onDeleteMessage}>
								<span onClick={(e) => e.stopPropagation()}>
									<button
										class="cursor-pointer p-1 size-5 text-[var(--text-muted)] hover:text-[var(--text-error)] !border-none !bg-transparent !shadow-none"
										type="button"
										title={t('deleteMessage')}
										onClick={() =>
											props.onDeleteMessage?.(props.item.message.id)
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
											<polyline points="3 6 5 6 21 6" />
											<path d="M19 6l-1 14H6L5 6" />
											<path d="M10 11v6M14 11v6" />
											<path d="M9 6V4h6v2" />
										</svg>
									</button>
								</span>
							</Show>
						</div>
					</summary>
					<Show when={props.item.toolCall}>
						<>
							<div class="mt-3 text-xs text-[var(--text-muted)]">
								{t('params')}
							</div>
							<pre class="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-2 bg-[var(--background-secondary)] p-2 text-xs leading-5">
								{JSON.stringify(props.item.toolCall?.input ?? {}, null, 2)}
							</pre>
						</>
					</Show>
					<div class="mt-3 text-xs text-[var(--text-muted)]">{t('result')}</div>
					<pre class="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-2 bg-[var(--background-secondary)] p-2 text-xs leading-5">
						{(
							content() as
								| Array<{
										type: string
										output?: { type: string; value?: string }
								  }>
								| null
								| undefined
						)
							?.filter((p) => p.type === 'tool-result')
							.map((p) =>
								p.output?.type === 'text' ? (p.output.value ?? '') : '',
							)
							.join('\n') || ''}
					</pre>
				</details>
			}
		>
			<div
				class={`rounded-3 p-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] ${
					props.item.message.isError ? 'border-[var(--text-error)]' : ''
				}`}
			>
				<div class="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
					<div class="font-medium text-[var(--text-normal)]">{roleLabel()}</div>
					<span>{formatTime(props.item.message.createdAt)}</span>
				</div>
				<ContentParts
					content={
						Array.isArray(content())
							? (content() as ChatMessageContentPart[])
							: null
					}
					renderMarkdown={props.renderMarkdown}
				/>
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
					<div class="mt-3 flex items-center justify-between gap-2">
						<div class="flex items-center gap-0.5">
							<CopyButton getText={getText} />
							<Show when={props.onDeleteMessage}>
								<button
									class="cursor-pointer p-1 size-6 text-[var(--text-muted)] hover:text-[var(--text-error)] !border-none !bg-transparent !shadow-none"
									type="button"
									title={t('deleteMessage')}
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
									title={t('recallMessage')}
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
									title={t('regenerateMessage')}
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
		</Show>
	)
}

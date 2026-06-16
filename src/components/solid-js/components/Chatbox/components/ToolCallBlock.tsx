import { setIcon } from 'obsidian'
import { Show } from 'solid-js'
import { t } from '../../../i18n'
import type {
	ChatDisplayToolCallBlock,
	ChatDisplayToolResultBlock,
} from '../types'

function toolResultText(toolMessage?: { message: { content?: unknown } }) {
	const parts = Array.isArray(toolMessage?.message.content)
		? (toolMessage?.message.content as Array<{
				type: string
				output?: { type?: string; value?: string }
			}>)
		: []
	return parts
		.filter((part) => part.type === 'tool-result')
		.map((part) =>
			part.output?.type === 'text' ? (part.output.value ?? '') : '',
		)
		.join('\n')
}

function toolNameFromMessage(toolMessage?: { message: { content?: unknown } }) {
	const firstPart = Array.isArray(toolMessage?.message.content)
		? (
				toolMessage?.message.content as Array<{
					type: string
					toolName?: string
				}>
			)[0]
		: undefined
	return firstPart?.type === 'tool-result' ? firstPart.toolName : undefined
}

export function ToolCallBlock(props: { block: ChatDisplayToolCallBlock }) {
	const resultText = () => toolResultText(props.block.toolMessage)
	const title = () =>
		toolNameFromMessage(props.block.toolMessage) ||
		props.block.toolCall.toolName

	return (
		<details class="group rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)]">
			<summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 text-xs text-[var(--text-muted)] marker:hidden">
				<div class="flex min-w-0 items-center gap-2">
					<span
						class="flex size-6 p-1 shrink-0 items-center justify-center rounded-full border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-muted)]"
						ref={(el) => {
							setIcon(el, 'hammer')
						}}
					>
						{' '}
					</span>
					<div class="truncate font-medium text-[var(--text-normal)]">
						{title()}
					</div>
				</div>
				<svg
					class="size-4 shrink-0 transition-transform group-open:rotate-180"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
			</summary>
			<div class="border-t border-[var(--background-modifier-border)] px-3 py-3">
				<div class="text-xs text-[var(--text-muted)]">
					{t('chatbox.ui.labels.params')}
				</div>
				<pre class="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-2 bg-[var(--background-primary)] p-2 text-xs leading-5">
					{JSON.stringify(props.block.toolCall.input ?? {}, null, 2)}
				</pre>
				<Show when={resultText().trim()}>
					<div class="mt-3 text-xs text-[var(--text-muted)]">
						{t('chatbox.ui.labels.result')}
					</div>
					<pre class="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-2 bg-[var(--background-primary)] p-2 text-xs leading-5">
						{resultText()}
					</pre>
				</Show>
			</div>
		</details>
	)
}

export function ToolResultBlock(props: { block: ChatDisplayToolResultBlock }) {
	const title = () =>
		toolNameFromMessage(props.block.toolMessage) || t('chatbox.ui.labels.tool')

	return (
		<div class="rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)] p-3">
			<div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
				<span
					class="flex size-6 shrink-0 items-center justify-center rounded-full border border-[var(--background-modifier-border)] bg-[var(--background-primary)] text-[var(--text-muted)]"
					ref={(el) => {
						setIcon(el, 'hammer')
					}}
				/>
				<div class="font-medium text-[var(--text-normal)]">{title()}</div>
			</div>
			<div class="mt-3 text-xs text-[var(--text-muted)]">
				{t('chatbox.ui.labels.result')}
			</div>
			<pre class="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-2 bg-[var(--background-primary)] p-2 text-xs leading-5">
				{toolResultText(props.block.toolMessage)}
			</pre>
		</div>
	)
}

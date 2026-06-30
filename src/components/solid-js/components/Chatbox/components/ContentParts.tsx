import { For, Match, Show, Switch } from 'solid-js'
import type {
	ChatMessageContentPart,
	ReasoningPart,
	TextPart,
	ToolCallPart,
} from '~/ai/chat/types'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { imageFilePartSrc } from '~/ai/chat/messages/message-utils'
import { MarkdownContent } from './MarkdownContent'

function isTextPart(part: ChatMessageContentPart): part is TextPart {
	return part.type === 'text'
}

function isReasoningPart(part: ChatMessageContentPart): part is ReasoningPart {
	return part.type === 'reasoning'
}

function isToolCallPart(part: ChatMessageContentPart): part is ToolCallPart {
	return part.type === 'tool-call'
}

export function ContentParts(props: {
	content?: ChatMessageContentPart[] | null
	renderMarkdown?: ChatboxProps['renderMarkdown']
}) {
	return (
		<Show when={props.content?.length}>
			<div class="mt-2 flex flex-col gap-3">
				<For each={props.content || []}>
					{(part) => (
						<Switch>
							<Match when={isTextPart(part) ? part : undefined}>
								{(textPart) => (
									<MarkdownContent
										markdown={textPart().text ?? ''}
										renderMarkdown={props.renderMarkdown}
									/>
								)}
							</Match>
							<Match when={isReasoningPart(part) ? part : undefined}>
								{(reasoningPart) => (
									<details class="rounded-2 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)]">
										<summary class="cursor-pointer p-2 text-xs text-[var(--text-muted)] select-none">
											Reasoning
										</summary>
										<pre class="m-0 p-2 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-muted)]">
											{reasoningPart().text ?? ''}
										</pre>
									</details>
								)}
							</Match>
							<Match when={imageFilePartSrc(part)}>
								{(src) => (
									<img
										class="max-h-80 max-w-full rounded-2 border border-[var(--background-modifier-border)] object-contain"
										src={src()}
										alt=""
									/>
								)}
							</Match>
							<Match when={isToolCallPart(part) ? part : undefined}>
								{(toolCallPart) => (
									<div class="rounded-2 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)] p-2 text-xs">
										<div class="font-medium text-[var(--text-muted)]">
											{toolCallPart().toolName}
										</div>
										<pre class="m-0 mt-1 whitespace-pre-wrap break-words leading-5">
											{JSON.stringify(toolCallPart().input ?? {}, null, 2)}
										</pre>
									</div>
								)}
							</Match>
						</Switch>
					)}
				</For>
			</div>
		</Show>
	)
}

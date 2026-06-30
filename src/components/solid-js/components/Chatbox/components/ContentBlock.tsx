import { For, Match, Switch } from 'solid-js'
import type {
	ChatDisplayContentBlock,
	ChatMessageContentPart,
	ReasoningPart,
	TextPart,
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

export function ContentBlock(props: {
	block: ChatDisplayContentBlock
	renderMarkdown?: ChatboxProps['renderMarkdown']
}) {
	return (
		<div class="rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] p-3">
			<div class="flex flex-col gap-3">
				<For each={props.block.parts}>
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
						</Switch>
					)}
				</For>
			</div>
		</div>
	)
}

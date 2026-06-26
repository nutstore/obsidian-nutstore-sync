import { For, Match, Show, Switch } from 'solid-js'
import type { ChatMessageContentPart } from '~/ai/chat/types'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { MarkdownContent } from './MarkdownContent'

type AnyPart = {
	type: string
	text?: string
	image?: unknown
	input?: unknown
	toolName?: string
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
							<Match when={part.type === 'text'}>
								<MarkdownContent
									markdown={(part as AnyPart).text ?? ''}
									renderMarkdown={props.renderMarkdown}
								/>
							</Match>
							<Match when={part.type === 'reasoning'}>
								<details class="rounded-2 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)]">
									<summary class="cursor-pointer p-2 text-xs text-[var(--text-muted)] select-none">
										Reasoning
									</summary>
									<pre class="m-0 p-2 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-muted)]">
										{(part as AnyPart).text ?? ''}
									</pre>
								</details>
							</Match>
							<Match when={part.type === 'image'}>
								<img
									class="max-h-80 max-w-full rounded-2 border border-[var(--background-modifier-border)] object-contain"
									src={(part as AnyPart).image as string}
									alt=""
								/>
							</Match>
							<Match when={part.type === 'tool-call'}>
								<div class="rounded-2 border border-[var(--background-modifier-border)] bg-[var(--background-secondary)] p-2 text-xs">
									<div class="font-medium text-[var(--text-muted)]">
										{(part as AnyPart).toolName}
									</div>
									<pre class="m-0 mt-1 whitespace-pre-wrap break-words leading-5">
										{JSON.stringify((part as AnyPart).input ?? {}, null, 2)}
									</pre>
								</div>
							</Match>
						</Switch>
					)}
				</For>
			</div>
		</Show>
	)
}

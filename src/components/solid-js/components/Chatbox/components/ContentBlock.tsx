import { For, Match, Switch } from 'solid-js'
import type { ChatDisplayContentBlock } from '~/ai/chat/types'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { MarkdownContent } from './MarkdownContent'

type AnyPart = {
	type: string
	text?: string
	image?: unknown
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
						</Switch>
					)}
				</For>
			</div>
		</div>
	)
}

import { For, Match, Show, Switch } from 'solid-js'
import type { ChatMessageContentPart, ChatboxProps } from '../types'
import { MarkdownContent } from './MarkdownContent'

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
									markdown={
										(part as Extract<ChatMessageContentPart, { type: 'text' }>)
											.text
									}
									renderMarkdown={props.renderMarkdown}
								/>
							</Match>
							<Match when={part.type === 'image_url'}>
								<img
									class="max-h-80 max-w-full rounded-2 border border-[var(--background-modifier-border)] object-contain"
									src={
										(
											part as Extract<
												ChatMessageContentPart,
												{ type: 'image_url' }
											>
										).image_url.url
									}
									alt=""
								/>
							</Match>
							<Match when={part.type === 'unknown'}>
								<pre class="m-0 whitespace-pre-wrap break-words rounded-2 bg-[var(--background-secondary)] p-2 text-xs leading-5">
									{JSON.stringify(
										(
											part as Extract<
												ChatMessageContentPart,
												{ type: 'unknown' }
											>
										).value,
										null,
										2,
									)}
								</pre>
							</Match>
						</Switch>
					)}
				</For>
			</div>
		</Show>
	)
}

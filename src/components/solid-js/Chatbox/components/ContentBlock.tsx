import type { TextPart } from 'ai'
import { For, Match, Switch, useContext } from 'solid-js'
import { imageFilePartSrc } from '~/ai/chat/messages/message-utils'
import type { ChatDisplayContentBlock } from '~/ai/chat/types'
import type { ChatboxProps } from '~/ai/chat/ui/types'
import { CollapsibleAppearance } from './CollapsibleBlock'
import { MarkdownContent } from './MarkdownContent'

function isTextPart(
	part: ChatDisplayContentBlock['parts'][number],
): part is TextPart {
	return part.type === 'text'
}

export function ContentBlock(props: {
	block: ChatDisplayContentBlock
	renderMarkdown?: ChatboxProps['renderMarkdown']
	streaming?: boolean
}) {
	const appearance = useContext(CollapsibleAppearance)
	return (
		<div
			class={
				appearance === 'plain'
					? ':uno: chatbox-process-content min-w-0 py-1'
					: ':uno: rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] px-3 py-2.5'
			}
		>
			<div class=":uno: flex flex-col gap-3">
				<For each={props.block.parts}>
					{(part) => (
						<Switch>
							<Match when={isTextPart(part) ? part : undefined}>
								{(textPart) => (
									<MarkdownContent
										markdown={textPart().text ?? ''}
										renderMarkdown={props.renderMarkdown}
										streaming={props.streaming}
									/>
								)}
							</Match>
							<Match when={imageFilePartSrc(part)}>
								{(src) => (
									<img
										class=":uno: max-h-80 max-w-full rounded-2 border border-[var(--background-modifier-border)] object-contain"
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

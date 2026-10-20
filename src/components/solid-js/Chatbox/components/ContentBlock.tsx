import type { TextPart } from 'ai'
import { Index, Match, Switch, useContext } from 'solid-js'
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
	const textPart = (part: ChatDisplayContentBlock['parts'][number]) =>
		isTextPart(part) ? part : undefined
	return (
		<div
			class={
				appearance === 'plain'
					? ':uno: chatbox-process-content min-w-0 py-1'
					: ':uno: ns-content-block rounded-3 border border-[var(--background-modifier-border)] bg-[var(--background-primary-alt)] px-[var(--ns-chatbox-pad-x)] py-[var(--ns-chatbox-card-py)]'
			}
		>
			<div class=":uno: flex flex-col gap-[var(--ns-chatbox-gap)]">
				<Index each={props.block.parts}>
					{(part) => (
						<Switch>
							<Match when={textPart(part())}>
								{(textPart) => (
									<MarkdownContent
										markdown={textPart().text ?? ''}
										renderMarkdown={props.renderMarkdown}
										streaming={props.streaming}
									/>
								)}
							</Match>
							<Match when={imageFilePartSrc(part())}>
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
				</Index>
			</div>
		</div>
	)
}

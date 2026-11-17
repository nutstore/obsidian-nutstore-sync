import type { ChatDisplayReasoningBlock } from '~/ai/chat/types'
import { t } from '../../i18n'
import { reasoningPreview } from '../utils'
import { TitledCollapsibleBlock } from './CollapsibleBlock'

export function ReasoningBlock(props: {
	part: ChatDisplayReasoningBlock['part']
}) {
	return (
		<TitledCollapsibleBlock
			title={t('chatbox.ui.labels.reasoning')}
			preview={reasoningPreview(props.part.text)}
			iconClass=":uno: i-lucide-brain"
		>
			{() => (
				<pre class=":uno: m-0 whitespace-pre-wrap break-words text-xs leading-5 text-[var(--text-muted)]">
					{props.part.text ?? ''}
				</pre>
			)}
		</TitledCollapsibleBlock>
	)
}

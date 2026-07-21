import type { ChatDisplaySystemNotificationBlock } from '~/ai/chat/types'
import { t } from '../../../i18n'
import { TitledCollapsibleBlock } from './CollapsibleBlock'

export function SystemNotificationBlock(props: {
	block: ChatDisplaySystemNotificationBlock
}) {
	return (
		<TitledCollapsibleBlock
			title={t('chatbox.ui.labels.systemNotification')}
			iconClass="i-lucide-bell"
		>
			<pre class="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-2 bg-[var(--background-primary)] p-2 text-xs leading-5">
				{JSON.stringify(props.block.notification, null, 2)}
			</pre>
		</TitledCollapsibleBlock>
	)
}

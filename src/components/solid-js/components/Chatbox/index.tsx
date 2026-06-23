import { createMount } from '../../mount'
import Chatbox from './Chatbox'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export function mountChatbox(el: Element, props: ChatboxProps) {
	return createMount(Chatbox, el, props, { delegateEvents: true })
}

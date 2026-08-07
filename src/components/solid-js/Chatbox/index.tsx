import type { ChatboxProps } from '~/ai/chat/ui/types'
import { createMount } from '../mount'
import Chatbox from './Chatbox'

export function mountChatbox(el: Element, props: ChatboxProps) {
	return createMount(Chatbox, el, props, { delegateEvents: true })
}

import { createMount } from '../../mount'
import Chatbox from './Chatbox'
import { ChatboxProps } from './types'
export * from './types'

export function mountChatbox(el: Element, props: ChatboxProps) {
	return createMount(Chatbox, el, props, { delegateEvents: true })
}

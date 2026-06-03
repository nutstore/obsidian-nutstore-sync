import { createStore, reconcile } from 'solid-js/store'
import { DelegatedEvents, delegateEvents, render } from 'solid-js/web'
import Chatbox from './Chatbox'
import { ChatboxProps } from './types'
export * from './types'

export interface ChatboxController {
	update: (props: ChatboxProps) => void
	destroy: () => void
}

export function mountChatbox(
	el: Element,
	props: ChatboxProps,
): ChatboxController {
	let update = (_props: ChatboxProps) => {}
	const ownerDocument = el.ownerDocument ?? document
	delegateEvents(Array.from(DelegatedEvents), ownerDocument)
	const destroy = render(() => {
		const [state, setState] = createStore(props)
		update = (nextProps: ChatboxProps) => {
			setState(reconcile(nextProps))
		}
		return <Chatbox {...state} />
	}, el)

	return {
		update,
		destroy,
	}
}

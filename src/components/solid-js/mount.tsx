import { JSX } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { DelegatedEvents, delegateEvents, render } from 'solid-js/web'

export interface MountController<T> {
	update: (next: T) => void
	destroy: () => void
}

export interface MountOptions {
	delegateEvents?: boolean
}

export function createMount<T extends object>(
	Component: (props: T) => JSX.Element,
	el: Element,
	initialProps: T,
	options?: MountOptions,
): MountController<T> {
	if (options?.delegateEvents) {
		delegateEvents(Array.from(DelegatedEvents), el.ownerDocument ?? document)
	}

	let setState!: (next: T) => void

	const destroy = render(() => {
		const [state, set] = createStore(initialProps)
		setState = (next) => set(reconcile(next))
		return <Component {...(state as T)} />
	}, el)

	return {
		update: (next) => setState(next),
		destroy,
	}
}

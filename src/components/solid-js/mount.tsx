import { JSX } from 'solid-js'
import { createStore, reconcile } from 'solid-js/store'
import { DelegatedEvents, delegateEvents, render } from 'solid-js/web'

export interface MountController<T> {
	update: (next: T) => void
	destroy: () => void
}

export interface MountOptions {
	/**
	 * `reconcile` deep-diffs every nested value and is required by lists whose
	 * items are mutated in place. `replace` assigns only changed top-level props,
	 * which keeps a chat timeline of stable item snapshots cheap to update.
	 */
	updateMode?: 'reconcile' | 'replace'
}

export function createMount<T extends object>(
	Component: (props: T) => JSX.Element,
	el: Element,
	initialProps: T,
	options: MountOptions = {},
): MountController<T> {
	delegateEvents(Array.from(DelegatedEvents), el.ownerDocument ?? document)

	const updateMode = options.updateMode ?? 'reconcile'
	let setState!: (next: T) => void

	const destroy = render(() => {
		const [state, set] = createStore(initialProps)
		if (updateMode === 'reconcile') {
			setState = (next) => set(reconcile(next))
		} else {
			let keys = new Set(Object.keys(initialProps))
			setState = (next) => {
				const nextKeys = new Set(Object.keys(next))
				// Optional props disappear (e.g. provider setup); only then is the
				// full reconcile needed to delete the stale key.
				if (
					nextKeys.size !== keys.size ||
					[...keys].some((key) => !nextKeys.has(key))
				) {
					keys = nextKeys
					set(reconcile(next))
					return
				}
				keys = nextKeys
				set(next)
			}
		}
		return <Component {...state} />
	}, el)

	return {
		update: (next) => setState(next),
		destroy,
	}
}

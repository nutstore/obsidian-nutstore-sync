import { createStore, reconcile } from 'solid-js/store'
import { render } from 'solid-js/web'
import TaskSelectionVirtualList, {
	TaskSelectionItem,
	TaskSelectionVirtualListProps,
} from './TaskSelectionVirtualList'

export type { TaskSelectionItem, TaskSelectionVirtualListProps }

export interface TaskSelectionVirtualListController {
	update: (items: TaskSelectionItem[]) => void
	destroy: () => void
}

export function mountTaskSelectionVirtualList(
	el: Element,
	props: Omit<TaskSelectionVirtualListProps, 'items'> & {
		items: TaskSelectionItem[]
	},
): TaskSelectionVirtualListController {
	let update = (_items: TaskSelectionItem[]) => {}
	const destroy = render(() => {
		const [state, setState] = createStore(props)
		update = (items: TaskSelectionItem[]) => {
			setState('items', reconcile(items))
		}
		return <TaskSelectionVirtualList {...state} />
	}, el)

	return {
		update,
		destroy,
	}
}

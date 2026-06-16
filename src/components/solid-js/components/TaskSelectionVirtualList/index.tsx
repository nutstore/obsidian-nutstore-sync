import { createMount, MountController } from '../../mount'
import TaskSelectionVirtualList, {
	TaskSelectionItem,
	TaskSelectionVirtualListProps,
} from './TaskSelectionVirtualList'

export type { TaskSelectionItem, TaskSelectionVirtualListProps }

export type TaskSelectionVirtualListController =
	MountController<TaskSelectionVirtualListProps>

export function mountTaskSelectionVirtualList(
	el: Element,
	props: TaskSelectionVirtualListProps,
): TaskSelectionVirtualListController {
	return createMount(TaskSelectionVirtualList, el, props)
}

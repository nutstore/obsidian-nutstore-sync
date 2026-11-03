import { createMount, MountController } from '../mount'
import ScanIssueList, {
	ScanIssueListProps,
	ScanIssueRow,
} from './ScanIssueList'

export type { ScanIssueListProps, ScanIssueRow }

export type ScanIssueListController = MountController<ScanIssueListProps>

export function mountScanIssueList(
	el: Element,
	props: ScanIssueListProps,
): ScanIssueListController {
	return createMount(ScanIssueList, el, props)
}

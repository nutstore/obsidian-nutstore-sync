import { render } from 'solid-js/web'
import WebDAVExplorer, { WebDAVExplorerProps } from './WebDAVExplorer'

export function mountWebDAVExplorer(el: Element, props: WebDAVExplorerProps) {
	return render(() => <WebDAVExplorer {...props} />, el)
}

import './assets/styles/global.css'

import { render } from 'solid-js/web'
import App, { AppProps } from './App'

export function mount(el: Element, props: AppProps) {
	return render(() => <App {...props} />, el)
}

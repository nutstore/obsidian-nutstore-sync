import { Observable } from 'rxjs'

export default function <T>(ob: Observable<T>, ms: number) {
	return new Promise<void>((resolve, reject) => {
		const sub = ob.subscribe({
			next: () => finish(),
			error: (err) => {
				window.clearTimeout(timer)
				sub.unsubscribe()
				reject(err)
			},
		})

		function finish() {
			window.clearTimeout(timer)
			sub.unsubscribe()
			resolve()
		}

		const timer = window.setTimeout(() => {
			finish()
		}, ms)
	})
}

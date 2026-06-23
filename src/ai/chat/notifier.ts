export class Notifier {
	private readonly listeners = new Set<() => void>()

	subscribe(listener: () => void) {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	notify() {
		for (const listener of this.listeners) {
			listener()
		}
	}
}

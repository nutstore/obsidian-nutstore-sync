export interface AppRemovalOptions {
	force?: boolean
}

/** The lifecycle owner serializes App deletion with host-state, KV and log writes. */
export interface AppLifecycle {
	remove(appId: string, options?: AppRemovalOptions): Promise<void>
}

/** One serialization authority for every host-owned operation on an App. */
export class AppLifecycleQueue {
	private readonly queues = new Map<string, Promise<unknown>>()

	run<T>(appId: string, action: () => Promise<T>): Promise<T> {
		const next = (this.queues.get(appId) ?? Promise.resolve())
			.catch(() => {})
			.then(action)
		this.queues.set(appId, next)
		void next
			.finally(() => {
				if (this.queues.get(appId) === next) this.queues.delete(appId)
			})
			.catch(() => {})
		return next
	}

	async settle() {
		while (this.queues.size) await Promise.allSettled([...this.queues.values()])
	}
}

import { createAbortError, isAbortError, throwIfAborted } from '~/utils/abort'
import { raceWithAbort } from '~/utils/abortable'

export enum ModuleState {
	Enabled = 'enabled',
	Disabled = 'disabled',
}

export function normalizeModuleState(value: unknown): ModuleState {
	return value === ModuleState.Disabled ? value : ModuleState.Enabled
}

/** One activation owns its resources. Revocation is permanent, even after re-enabling. */
export class ModuleScope {
	private readonly controller = new AbortController()
	private readonly disposers = new Set<() => void>()
	private readonly pendingIO = new Set<Promise<unknown>>()
	readonly signal = this.controller.signal

	check = () => throwIfAborted(this.signal)

	track = (promise: Promise<unknown>) => {
		this.pendingIO.add(promise)
		void promise.finally(() => this.pendingIO.delete(promise)).catch(() => {})
	}

	/** Submitted I/O may finish, but a new activation must not race its writes. */
	async settle() {
		while (this.pendingIO.size) await Promise.allSettled([...this.pendingIO])
	}

	register(dispose: () => void): () => void {
		if (this.signal.aborted) dispose()
		else this.disposers.add(dispose)
		return () => this.disposers.delete(dispose)
	}

	close() {
		if (this.signal.aborted) return
		this.controller.abort(createAbortError('Module disabled'))
		const errors: unknown[] = []
		for (const dispose of [...this.disposers].reverse()) {
			try {
				dispose()
			} catch (error) {
				errors.push(error)
			}
		}
		this.disposers.clear()
		if (errors.length) throw new AggregateError(errors, 'Module cleanup failed')
	}

	async wait<T>(promise: Promise<T>): Promise<T> {
		// Attach the rejection handler even when revocation preceded this call.
		const observed = promise.catch((error: unknown) => {
			throw error
		})
		if (this.signal.aborted) {
			void observed.catch(() => {})
			this.check()
		}
		const value = await raceWithAbort(observed, this.signal)
		this.check()
		return value
	}

	/** Background work owns its errors; cancellation never becomes a user-facing failure. */
	async background(
		work: () => Promise<unknown>,
		report: (error: unknown) => void,
	) {
		try {
			this.check()
			await work()
		} catch (error) {
			if (!this.signal.aborted && !isAbortError(error)) report(error)
		}
	}

	ownModal<T extends { close(): void; onClose(): unknown }>(modal: T): T {
		this.check()
		const release = this.register(() => modal.close())
		const onClose = modal.onClose.bind(modal)
		modal.onClose = () => {
			release()
			return onClose()
		}
		return modal
	}
}

/** Serializes retirement and activation; disabling revokes access synchronously. */
export class ModuleLifecycle {
	private current?: ModuleScope
	private desired = false
	/** Tail of the serial transition chain; always settles as fulfilled. */
	private transition: Promise<void> = Promise.resolve()

	constructor(
		private readonly start: (scope: ModuleScope) => void,
		private readonly stop: () => void | Promise<void>,
	) {}

	get active() {
		return !!this.current && !this.current.signal.aborted
	}

	get scope(): ModuleScope {
		if (!this.current || !this.active) throw createAbortError('Module disabled')
		return this.current
	}

	update(enabled: boolean): Promise<void> {
		this.desired = enabled
		if (!enabled && this.current) {
			const scope = this.current
			this.current = undefined
			const errors: unknown[] = []
			try {
				scope.close()
			} catch (error) {
				errors.push(error)
			}
			let stopped: Promise<void>
			try {
				stopped = Promise.resolve(this.stop())
			} catch (error) {
				stopped = Promise.reject(
					error instanceof Error ? error : new Error(String(error)),
				)
			}
			const cleanup = stopped
				.catch((error: unknown) => {
					errors.push(error)
				})
				.then(async () => {
					await scope.settle()
					if (errors.length)
						throw new AggregateError(errors, 'Module shutdown failed')
				})
			return this.enqueue(cleanup)
		}
		if (enabled && !this.current) {
			return this.enqueue(async () => {
				if (!this.desired || this.current) return
				const scope = new ModuleScope()
				this.current = scope
				try {
					this.start(scope)
				} catch (error) {
					this.current = undefined
					try {
						scope.close()
					} finally {
						try {
							await this.stop()
						} finally {
							await scope.settle()
						}
					}
					throw error
				}
			})
		}
		return this.transition
	}

	/**
	 * Appends a step to the serial transition chain. The step's own outcome is
	 * returned to its caller; the chain itself never stays rejected, so one
	 * failed retirement or activation cannot block later transitions.
	 */
	private enqueue(step: Promise<void> | (() => Promise<void>)): Promise<void> {
		const result =
			typeof step === 'function'
				? this.transition.then(step)
				: this.transition.then(() => step)
		this.transition = result.catch(() => {})
		return result
	}
}

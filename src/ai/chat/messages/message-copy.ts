import type { ModelMessage } from 'ai'

function copyArrayBufferView<T extends ArrayBufferView>(view: T): T {
	const bytes = new Uint8Array(view.byteLength)
	bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
	if (view instanceof DataView) {
		return new DataView(bytes.buffer) as unknown as T
	}
	const View = view.constructor as new (buffer: ArrayBuffer) => T
	return new View(bytes.buffer)
}

function copyMutableData<T>(value: T): T {
	if (!value || typeof value !== 'object' || value instanceof Blob) {
		return value
	}
	if (value instanceof ArrayBuffer) {
		return value.slice(0) as T
	}
	if (ArrayBuffer.isView(value)) {
		return copyArrayBufferView(value) as T
	}
	if (value instanceof URL) {
		return new URL(value.href) as T
	}
	if (Array.isArray(value)) {
		return value.map(copyMutableData) as T
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		return value
	}
	const copied = Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, copyMutableData(entry)]),
	)
	return (
		prototype === null ? Object.assign(Object.create(null), copied) : copied
	) as T
}

export function copyModelMessage(message: ModelMessage): ModelMessage {
	return copyMutableData(message)
}

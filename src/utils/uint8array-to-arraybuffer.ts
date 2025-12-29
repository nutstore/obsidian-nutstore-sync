export function uint8ArrayToArrayBuffer(data: Uint8Array<ArrayBuffer>) {
	if (data.buffer.byteLength === data.byteLength && data.byteOffset === 0) {
		return data.buffer
	}
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
}

import { fromUint8Array } from 'js-base64'

export async function sha256(data: ArrayBuffer) {
	return crypto.subtle.digest('SHA-256', data)
}

export async function sha256Hex(data: ArrayBuffer) {
	const hashBuffer = await sha256(data)
	const hashArray = Array.from(new Uint8Array(hashBuffer))
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
	return hashHex
}

export async function sha256Base64(data: ArrayBuffer) {
	const hashBuffer = await sha256(data)
	const hashBase64 = fromUint8Array(new Uint8Array(hashBuffer), false)
	return hashBase64
}

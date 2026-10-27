import { fromUint8Array } from 'js-base64'

/** Shared by App assembly and chat attachments so data URLs have one formatter. */
export function bytesToDataUrl(
	mediaType: string,
	bytes: ArrayBuffer | Uint8Array,
) {
	const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
	return `data:${mediaType};base64,${fromUint8Array(data, false)}`
}

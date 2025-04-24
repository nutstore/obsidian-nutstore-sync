import { sha256Base64 } from '~/utils/sha256'
import { blobKV } from './kv'

export function useBlobStore() {
	function get(key: string) {
		return blobKV.get(key)
	}
	async function store(value: Blob | ArrayBuffer) {
		let key: string
		let blob: Blob
		if (value instanceof Blob) {
			key = await sha256Base64(await value.arrayBuffer())
			blob = value
		} else {
			key = await sha256Base64(value)
			blob = new Blob([value])
		}
		return {
			key,
			value: await blobKV.set(key, blob),
		}
	}
	return {
		get,
		store,
	}
}

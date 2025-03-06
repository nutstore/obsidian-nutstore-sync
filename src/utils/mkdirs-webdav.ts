import { WebDAVClient } from 'webdav'

export function mkdirsWebDAV(client: WebDAVClient, path: string) {
	return client.createDirectory(path, {
		recursive: true,
	})
}

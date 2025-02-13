import { WebDAVClient } from 'webdav'

export function mkdirsWedbDAV(client: WebDAVClient, path: string) {
	return client.createDirectory(path, {
		recursive: true,
	})
}

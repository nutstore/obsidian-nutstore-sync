import { createClient, WebDAVClient } from 'webdav'
import { DAV_API } from '~/consts'
import NutStorePlugin from '..'
import IFileSystem from './fs.interface'

export class NutstoreFileSystem implements IFileSystem {
	private webdav: WebDAVClient

	constructor(
		private options: {
			plugin: NutStorePlugin
			token: string
			remoteDir: string
		},
	) {
		this.webdav = createClient(DAV_API, {
			headers: {
				Authorization: `Basic ${this.options.token}`,
			},
		})
	}

	async walk() {
		return []
	}
}

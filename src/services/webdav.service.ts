import { createClient, WebDAVClient } from 'webdav'
import { NS_DAV_ENDPOINT } from '../consts'
import NutstorePlugin from '../index'
import { createRateLimitedWebDAVClient } from '../utils/rate-limited-client'

export class WebDAVService {
	constructor(private plugin: NutstorePlugin) {}

	async createWebDAVClient(): Promise<WebDAVClient> {
		let client: WebDAVClient
		if (this.plugin.settings.loginMode === 'manual') {
			client = createClient(NS_DAV_ENDPOINT, {
				username: this.plugin.settings.account,
				password: this.plugin.settings.credential,
			})
		} else {
			const oauth = await this.plugin.getDecryptedOAuthInfo()
			client = createClient(NS_DAV_ENDPOINT, {
				username: oauth.username,
				password: oauth.access_token,
			})
		}
		return createRateLimitedWebDAVClient(client)
	}

	async checkWebDAVConnection(): Promise<{ error?: Error; success: boolean }> {
		try {
			const client = await this.createWebDAVClient()
			return { success: await client.exists('/') }
		} catch (error) {
			return {
				error,
				success: false,
			}
		}
	}
}

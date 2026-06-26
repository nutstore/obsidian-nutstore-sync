import { createClient, WebDAVClient } from 'webdav'
import NutstorePlugin from '../index'
import { getNutstoreDavEndpoint } from '../utils/nutstore-endpoints'
import { createRateLimitedWebDAVClient } from '../utils/rate-limited-client'

export class WebDAVService {
	constructor(private plugin: NutstorePlugin) {}

	async createWebDAVClient(): Promise<WebDAVClient> {
		const davEndpoint = getNutstoreDavEndpoint(this.plugin.settings)
		let client: WebDAVClient
		if (this.plugin.settings.loginMode === 'manual') {
			client = createClient(davEndpoint, {
				username: this.plugin.settings.account,
				password: this.plugin.settings.credential,
			})
		} else {
			const oauth = await this.plugin.getDecryptedOAuthInfo()
			client = createClient(davEndpoint, {
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
			const normalizedError =
				error instanceof Error ? error : new Error(String(error))
			return {
				error: normalizedError,
				success: false,
			}
		}
	}
}

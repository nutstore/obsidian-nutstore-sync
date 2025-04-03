import { decryptSecret } from '@nutstore/sso-js'

export interface OAuthResponse {
	username: string
	userid: string
	access_token: string
}

export async function decryptOAuthResponse(cipherText: string) {
	const json = await decryptSecret({
		app: 'obsidian',
		s: cipherText,
	})
	return JSON.parse(json) as OAuthResponse
}

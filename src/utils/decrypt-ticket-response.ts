import { decrypt } from '@nutstore/obsidian-sso'

export interface OAuthResponse {
	username: string
	userid: string
	access_token: string
}

export async function decryptOAuthResponse(cipherText: string) {
	const json = await decrypt(cipherText)
	return JSON.parse(json) as OAuthResponse
}

import { decrypt } from '@nutstore/sso-wasm'

export interface OAuthResponse {
	username: string
	userid: string
	access_token: string
}

export async function decryptOAuthResponse(cipherText: string) {
	const json = await decrypt('obsidian', cipherText)
	return JSON.parse(json) as OAuthResponse
}

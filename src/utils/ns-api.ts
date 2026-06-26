import { useSettings } from '~/settings'
import { getNutstoreNsdavEndpoint } from './nutstore-endpoints'

export async function NSAPI(name: 'delta' | 'latestDeltaCursor') {
	const settings = await useSettings()
	return `${getNutstoreNsdavEndpoint(settings)}/${name}`
}

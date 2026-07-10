import type { NutstoreSettings } from '~/settings'
import { getNutstoreNsdavEndpoint } from './nutstore-endpoints'

export function NSAPI(
	settings: NutstoreSettings,
	name: 'delta' | 'latestDeltaCursor',
) {
	return `${getNutstoreNsdavEndpoint(settings)}/${name}`
}

import { NS_NSDAV_ENDPOINT } from '~/consts'

export function NSAPI(name: 'delta' | 'latestDeltaCursor') {
	return `${NS_NSDAV_ENDPOINT}/${name}`
}

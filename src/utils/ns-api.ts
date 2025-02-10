import { NSDAV_API } from '~/consts'

export function NSAPI(name: 'delta' | 'latestDeltaCursor') {
	return `${NSDAV_API}/${name}`
}

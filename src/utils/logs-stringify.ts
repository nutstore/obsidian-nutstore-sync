import deepStringify from './deep-stringify'

export default function (logs: any) {
	if (typeof logs === 'string') {
		return logs
	}
	try {
		return JSON.stringify(logs)
	} catch {
		try {
			return deepStringify(logs)
		} catch {}
	}
}

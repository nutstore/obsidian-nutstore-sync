import { WebDAVClient } from 'webdav'
import { apiLimiter } from './api-limiter'

export function createRateLimitedWebDAVClient(
	client: WebDAVClient,
): WebDAVClient {
	return new Proxy(client, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver)
			if (typeof value === 'function') {
				return (...args: any[]) => {
					return apiLimiter.schedule(() => value.apply(target, args))
				}
			}
			return value
		},
	})
}

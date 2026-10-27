import { WebDAVClient } from 'webdav'
import { apiLimiter } from './api-limiter'

export function createRateLimitedWebDAVClient(
	client: WebDAVClient,
	check: () => void = () => {},
): WebDAVClient {
	return new Proxy(client, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver) as unknown
			if (typeof value === 'function') {
				const callable = value as (...args: unknown[]) => unknown
				return (...args: unknown[]) => {
					check()
					return apiLimiter.schedule(async () => {
						check()
						const result = await callable.apply(target, args)
						check()
						return result
					})
				}
			}
			return value
		},
	})
}

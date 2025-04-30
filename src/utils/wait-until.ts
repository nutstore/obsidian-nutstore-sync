import sleep from './sleep'

export default async function waitUntil<T>(condition: () => T, duration = 100) {
	while (true) {
		const result = await Promise.resolve(condition())
		if (result) {
			return result
		}
		await sleep(duration)
	}
}

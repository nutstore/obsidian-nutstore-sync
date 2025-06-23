export default async function sleep(ms: number) {
	await new Promise((resolve) => window.setTimeout(resolve, ms))
}

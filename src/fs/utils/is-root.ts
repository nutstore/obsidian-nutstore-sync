export default function isRoot(path: string) {
	return path === '/' || path === '.' || path === ''
}

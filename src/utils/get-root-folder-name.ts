import { normalize } from 'path-browserify'

export function getRootFolderName(path: string) {
	path = normalize(path)
	if (path.startsWith('/')) {
		path = path.slice(1)
	}
	return path.split('/')[0]
}

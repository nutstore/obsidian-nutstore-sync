import { getDirectoryContents } from '~/api/webdav'
import { StatModel } from '~/model/stat.model'
import { apiLimiter } from './api-limiter'
import { fileStatToStatModel } from './file-stat-to-stat-model'

const getContents = apiLimiter.wrap(getDirectoryContents)

export async function traverseWebDAV(
	token: string,
	from: string = '',
): Promise<StatModel[]> {
	const contents = await getContents(token, from)
	return [
		contents.map(fileStatToStatModel),
		await Promise.all(
			contents
				.filter((item) => item.type === 'directory')
				.map((item) => traverseWebDAV(token, item.filename)),
		),
	].flat(2)
}

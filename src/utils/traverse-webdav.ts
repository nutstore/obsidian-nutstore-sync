import dayjs from 'dayjs'
import { FileStat, WebDAVClient } from 'webdav'
import { StatModel } from '~/model/stat.model'
import { apiLimiter } from './api-limiter'

const getDirectoryContents = apiLimiter.wrap(
	(client: WebDAVClient, path: string) =>
		client.getDirectoryContents(path, {
			details: false,
			deep: false,
		}) as Promise<FileStat[]>,
)

export async function traverseWebDAV(
	client: WebDAVClient,
	from: string = '',
): Promise<StatModel[]> {
	const contents = await getDirectoryContents(client, from)
	return [
		contents.map((item) => ({
			path: item.filename,
			basename: item.basename,
			isDir: item.type === 'directory',
			mtime: dayjs(item.lastmod),
		})),
		await Promise.all(
			contents
				.filter((item) => item.type === 'directory')
				.map((item) => traverseWebDAV(client, item.filename)),
		),
	].flat(2)
}

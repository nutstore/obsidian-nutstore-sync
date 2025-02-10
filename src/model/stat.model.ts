import { Dayjs } from 'dayjs'

export interface StatModel {
	path: string
	basename: string
	isDir: boolean
	mtime: Dayjs
}

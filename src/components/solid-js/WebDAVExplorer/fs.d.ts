type MaybePromise<T> = Promise<T> | T

export interface fs {
	ls: (path: string) => MaybePromise<FileStat[]>
	mkdirs: (path: string) => MaybePromise<void>
}

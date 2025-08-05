export type StatModel =
	| {
			path: string
			basename: string
			isDir: true
			isDeleted: boolean
			mtime?: number
	  }
	| {
			path: string
			basename: string
			isDir: false
			isDeleted: boolean
			mtime: number
			size: number
	  }

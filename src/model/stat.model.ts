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
			/** Exact verbatim server ETag (`null` when unknown); directories never carry an ETag. */
			etag?: string | null
			/** Delta object version used only for fast-path short-circuiting. */
			revision?: number
	  }

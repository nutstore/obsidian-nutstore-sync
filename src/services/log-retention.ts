import { deflateSync, inflateSync } from 'fflate'

/** Lines kept in memory for the "save logs to note" flow. */
export const LOG_RETENTION_LINE_LIMIT = 100_000

/**
 * Compressed-byte budget for the retained log text.
 *
 * The line limit alone cannot bound memory: one line may carry an arbitrarily
 * large payload, and incompressible content compresses poorly. Normal log text
 * compresses ~10-20x, so this budget only binds for pathological logs.
 */
export const LOG_RETENTION_BYTE_LIMIT = 16 * 1024 * 1024

/** A chunk is sealed once it holds this many log entries, or this many characters. */
const CHUNK_LINE_LIMIT = 256
const CHUNK_CHAR_LIMIT = 64 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** A sealed run of formatted lines, deflated (or raw text if it failed). */
interface LogChunk {
	data: Uint8Array | string
	lines: number
}

export interface LogRetentionStats {
	/**
	 * Log entries currently retained, including the pending (not yet sealed) tail.
	 * A formatted entry with a multi-line stack counts once; the saved text may
	 * therefore hold more physical newline lines than this number.
	 */
	lines: number
	sealedChunks: number
	pendingLines: number
	/** Bytes held by the sealed chunks, after compression. */
	compressedBytes: number
}

export interface LogRetentionLimits {
	lineLimit: number
	byteLimit: number
}

/** Receives one expanded chunk at a time; resolves once it is safely written. */
export type LogSink = (text: string) => Promise<void>

/**
 * Bounded, in-memory retention of fully formatted log lines.
 *
 * Lines arrive already formatted (the caller snapshots them at log time), so
 * retained text can neither pin live objects nor change retroactively when the
 * logged object is mutated. Sealing deflates a run of lines into a chunk (raw
 * deflate at level 1: log text is redundant, and the cheapest level already
 * shrinks it ~10x, so compression stays a sub-millisecond per chunk);
 * eviction drops the oldest *whole* chunk, so no line is ever truncated and the
 * newest chunk always survives - it holds the event being diagnosed. Because
 * retention is enforced in whole chunks, the retained entry count may exceed
 * `lineLimit` by one chunk plus the pending tail (at most 2 * CHUNK_LINE_LIMIT - 1
 * entries).
 */
export class LogRetention {
	private chunks: LogChunk[] = []
	private pending: string[] = []
	private pendingChars = 0
	private lines = 0
	private compressedBytes = 0
	private readonly limits: LogRetentionLimits

	constructor(limits?: LogRetentionLimits) {
		this.limits = limits ?? {
			lineLimit: LOG_RETENTION_LINE_LIMIT,
			byteLimit: LOG_RETENTION_BYTE_LIMIT,
		}
	}

	append(line: string) {
		this.pending.push(line)
		this.pendingChars += line.length
		this.lines++
		if (
			this.pending.length >= CHUNK_LINE_LIMIT ||
			this.pendingChars >= CHUNK_CHAR_LIMIT
		) {
			this.seal()
		}
	}

	get stats(): LogRetentionStats {
		return {
			lines: this.lines,
			sealedChunks: this.chunks.length,
			pendingLines: this.pending.length,
			compressedBytes: this.compressedBytes,
		}
	}

	/**
	 * Every retained entry, oldest first, joined with newlines, but only one
	 * expanded chunk is alive at a time: the sink is awaited before the next
	 * chunk is inflated. Peak memory therefore stays chunk-sized (the expanded
	 * block plus the copy handed to the sink), independent of how much history
	 * is stored.
	 *
	 * The chunk list and pending tail are snapshotted before the first await, so
	 * entries logged while the sink writes belong to the next export instead of
	 * landing in the middle of a note whose content is already being written.
	 */
	async writeTo(sink: LogSink): Promise<void> {
		const chunks = this.chunks.slice()
		const pending = this.pending.slice()
		let separator = ''
		for (const part of this.parts(chunks, pending)) {
			await sink(separator + part)
			separator = '\n'
		}
	}

	/**
	 * Every retained entry as one string. Convenience for small reads and tests;
	 * production export must use `writeTo`, because this materialises the whole
	 * history at once.
	 */
	collect(): string {
		return [...this.parts(this.chunks, this.pending)].join('\n')
	}

	clear() {
		this.chunks = []
		this.pending = []
		this.pendingChars = 0
		this.lines = 0
		this.compressedBytes = 0
	}

	private seal() {
		if (this.pending.length === 0) return
		const text = this.pending.join('\n')
		const lines = this.pending.length
		this.pending = []
		this.pendingChars = 0
		const chunk: LogChunk = { data: compress(text), lines }
		this.chunks.push(chunk)
		this.compressedBytes += byteSize(chunk)
		this.evict()
	}

	private evict() {
		while (
			this.chunks.length > 1 &&
			(this.lines > this.limits.lineLimit ||
				this.compressedBytes > this.limits.byteLimit)
		) {
			const dropped = this.chunks.shift()!
			this.lines -= dropped.lines
			this.compressedBytes -= byteSize(dropped)
		}
	}

	private expand(chunk: LogChunk): string {
		return typeof chunk.data === 'string'
			? chunk.data
			: decoder.decode(inflateSync(chunk.data))
	}

	private *parts(chunks: LogChunk[], pending: string[]): Generator<string> {
		for (const chunk of chunks) yield this.expand(chunk)
		if (pending.length > 0) yield pending.join('\n')
	}
}

function compress(text: string): Uint8Array | string {
	try {
		return deflateSync(encoder.encode(text), { level: 1 })
	} catch {
		// Compression is an optimisation: a diagnostic must never be dropped
		// because the compressor failed.
		return text
	}
}

/** Approximate live-memory cost of a chunk, in bytes. */
function byteSize(chunk: LogChunk): number {
	return typeof chunk.data === 'string'
		? chunk.data.length * 2
		: chunk.data.length
}

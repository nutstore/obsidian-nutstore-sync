/**
 * Encoding hints to improve text detection accuracy for non-UTF-8 files.
 */
export type EncodingHint =
	| 'utf-16' // UTF-16 (auto-detect endianness)
	| 'utf-16le' // UTF-16 Little Endian
	| 'utf-16be' // UTF-16 Big Endian
	| 'latin1' // ISO-8859-1 / Latin-1
	| 'iso-8859-1' // Alias for latin1
	| 'cjk' // Generic CJK (Big5, GB2312, GBK, EUC-KR, Shift-JIS)
	| 'big5' // Traditional Chinese
	| 'gb2312' // Simplified Chinese
	| 'gbk' // Extended GB2312
	| 'euc-kr' // Korean
	| 'shift-jis' // Japanese

const MAX_BYTES = 512

/**
 * Detect UTF-16 without BOM by analyzing null byte patterns.
 * UTF-16LE: ASCII chars have nulls at odd positions (e.g., 't\0e\0s\0t\0')
 * UTF-16BE: ASCII chars have nulls at even positions (e.g., '\0t\0e\0s\0t')
 */
export function detectUtf16NoBom(
	fileBuffer: Buffer,
	bytesRead: number,
): 'utf-16le' | 'utf-16be' | null {
	if (bytesRead < 4) return null

	const scanLength = Math.min(bytesRead, MAX_BYTES)
	let nullsAtEven = 0
	let nullsAtOdd = 0

	for (let i = 0; i < scanLength; i++) {
		if (fileBuffer[i] === 0x00) {
			if (i % 2 === 0) nullsAtEven++
			else nullsAtOdd++
		}
	}

	const totalNulls = nullsAtEven + nullsAtOdd

	// For UTF-16 ASCII text, roughly 30-70% of total bytes should be nulls
	// (pure ASCII = 50%, mixed with non-ASCII = less)
	if (totalNulls > scanLength * 0.3 && totalNulls < scanLength * 0.7) {
		// UTF-16LE: nulls at odd positions (high bytes of little-endian chars)
		if (nullsAtOdd > nullsAtEven * 3) return 'utf-16le'
		// UTF-16BE: nulls at even positions (high bytes of big-endian chars)
		if (nullsAtEven > nullsAtOdd * 3) return 'utf-16be'
	}

	return null
}

/**
 * Check if the buffer is valid text for the given encoding hint.
 * Returns true if it's valid text (not binary), false if binary.
 */
export function isTextWithEncodingHint(
	fileBuffer: Buffer,
	bytesRead: number,
	encoding: EncodingHint,
): boolean {
	const scanLength = Math.min(bytesRead, MAX_BYTES)

	// Handle UTF-16 hints
	if (
		encoding === 'utf-16' ||
		encoding === 'utf-16le' ||
		encoding === 'utf-16be'
	) {
		// For UTF-16, null bytes are expected, so we just check for control characters
		for (let i = 0; i < scanLength; i += 2) {
			const byte1 = fileBuffer[i]
			const byte2 = i + 1 < scanLength ? fileBuffer[i + 1] : 0

			// In UTF-16, check for problematic control characters
			// Allow common ones: tab (0x09), newline (0x0A), carriage return (0x0D)
			if (encoding === 'utf-16le' || encoding === 'utf-16') {
				// LE: low byte first
				if (
					byte2 === 0 &&
					byte1 < 0x20 &&
					byte1 !== 0x09 &&
					byte1 !== 0x0a &&
					byte1 !== 0x0d &&
					byte1 !== 0x00
				) {
					return false
				}
			}
			if (encoding === 'utf-16be' || encoding === 'utf-16') {
				// BE: high byte first
				if (
					byte1 === 0 &&
					byte2 < 0x20 &&
					byte2 !== 0x09 &&
					byte2 !== 0x0a &&
					byte2 !== 0x0d &&
					byte2 !== 0x00
				) {
					return false
				}
			}
		}
		return true
	}

	// Handle Latin-1 / ISO-8859-1 hints
	if (encoding === 'latin1' || encoding === 'iso-8859-1') {
		for (let i = 0; i < scanLength; i++) {
			const byte = fileBuffer[i]
			// Null byte is never valid in Latin-1 text files
			if (byte === 0x00) return false
			// Control characters except TAB, LF, CR are suspicious
			if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
				return false
			}
			// Bytes 0x80-0xFF are all valid Latin-1 characters, so no check needed
		}
		return true
	}

	// Handle CJK encodings
	if (
		encoding === 'cjk' ||
		encoding === 'big5' ||
		encoding === 'gb2312' ||
		encoding === 'gbk' ||
		encoding === 'euc-kr' ||
		encoding === 'shift-jis'
	) {
		// For CJK, we trust the user's hint and only check for definitive binary indicators
		for (let i = 0; i < scanLength; i++) {
			const byte = fileBuffer[i]
			// Null byte is binary indicator even in CJK
			if (byte === 0x00) return false
			// Control characters (except TAB, LF, CR) suggest binary
			if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
				return false
			}
		}
		return true
	}

	// Unknown encoding, fall through to default behavior
	return false
}

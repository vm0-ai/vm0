// Hand-rolled audio duration parser. Reads only the first few KB of the file
// to extract duration from container headers without decoding the audio stream.
//
// WebM (EBML): the dominant format from browser MediaRecorder. Reads the
//   Duration element (0x4489) inside Info → Segment.
// WAV (RIFF): reads sample rate, channels, bits-per-sample, and data chunk
//   size to compute duration.
// Fallback: conservative file-size heuristic at 8 kbps floor.

const MIN_SPEECH_BITRATE_BPS = 8_000; // floor bitrate for fallback estimation
const MAX_READ_BYTES = 4_096; // enough for EBML header + first few elements
const EBML_HEADER = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);

export async function getAudioDuration(file: File): Promise<number | null> {
  const mimeType = file.type.split(";")[0] ?? file.type;
  const buf = new Uint8Array(
    await file.slice(0, Math.min(file.size, MAX_READ_BYTES)).arrayBuffer(),
  );

  if (mimeType === "audio/webm") {
    return parseWebmDuration(buf);
  }
  if (
    mimeType === "audio/wav" ||
    mimeType === "audio/wave" ||
    mimeType === "audio/x-wav"
  ) {
    return parseWavDuration(buf);
  }
  return estimateDurationFromSize(file.size);
}

function parseWebmDuration(buf: Uint8Array): number | null {
  if (buf.length < 12) return null;
  if (
    buf[0] !== EBML_HEADER[0] ||
    buf[1] !== EBML_HEADER[1] ||
    buf[2] !== EBML_HEADER[2] ||
    buf[3] !== EBML_HEADER[3]
  ) {
    return null;
  }

  let pos = 4;

  // The EBML header magic (0x1a45dfa3) was already matched. The next byte is the
  // element size vint. Read it and skip past the header's children to reach the
  // top-level Segment element.
  const ebmlSize = readVint(buf, pos);
  if (ebmlSize === null) return null;
  pos = ebmlSize.next + ebmlSize.value;

  // Expect Segment element (0x18 0x53 0x80 0x67) at next position
  if (pos + 4 > buf.length) return null;
  const segIdLen = vintLen(buf[pos] ?? 0);
  if (segIdLen === null) return null;
  if (segIdLen !== 4) return null; // Segment ID is 4-byte vint
  pos += segIdLen;
  // Segment size is typically unknown-length (all 1s in vint). Skip it.
  const segSizeLen = readVint(buf, pos);
  if (segSizeLen === null) return null;
  pos = segSizeLen.next;

  // Walk children of Segment looking for Info → Duration
  return findDurationInSegment(buf, pos);
}

function findDurationInSegment(buf: Uint8Array, pos: number): number | null {
  while (pos + 2 <= buf.length) {
    const idLen = vintLen(buf[pos] ?? 0);
    if (idLen === null || pos + idLen > buf.length) return null;
    const sizeResult = readVint(buf, pos + idLen);
    if (sizeResult === null) return null;

    const elemStart = pos;
    const dataPos = sizeResult.next;
    const dataSize = sizeResult.value;

    // Info element ID: 0x15 0x49 0xA9 0x66
    if (
      idLen === 4 &&
      buf[elemStart] === 0x15 &&
      buf[elemStart + 1] === 0x49 &&
      buf[elemStart + 2] === 0xa9 &&
      buf[elemStart + 3] === 0x66
    ) {
      return findDurationInInfo(buf, dataPos, dataSize);
    }

    // Skip other elements: move past their data
    pos = dataPos + Math.min(dataSize, buf.length - dataPos);
  }
  return null;
}

// WebM Info element children we care about. Per spec, Duration is stored in
// TimecodeScale units (not nanoseconds), and may be a 4- or 8-byte float; the
// previous implementation hard-read 8 bytes and treated the value as ns, which
// for Chrome MediaRecorder output (4-byte float, ms units) yielded values on
// the order of 1e21 seconds and tripped the AUDIO_DURATION_TOO_LONG guard.
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

function readDurationFloat(
  buf: Uint8Array,
  valuePos: number,
  valueSize: number,
): number | null {
  // Duration: float in TimecodeScale units (4 or 8 bytes per EBML spec)
  if (valuePos + valueSize > buf.length) return null;
  const view = new DataView(buf.buffer, buf.byteOffset + valuePos, valueSize);
  let value: number;
  if (valueSize === 8) {
    value = view.getFloat64(0, false);
  } else if (valueSize === 4) {
    value = view.getFloat32(0, false);
  } else {
    return null;
  }
  if (Number.isNaN(value) || value < 0) return null;
  return value;
}

function readTimecodeScale(
  buf: Uint8Array,
  valuePos: number,
  valueSize: number,
): number | null {
  // TimecodeScale: unsigned int in nanoseconds (default 1,000,000 = 1 ms)
  if (valuePos + valueSize > buf.length) return null;
  if (valueSize <= 0 || valueSize > 8) return null;
  let scale = 0;
  for (let i = 0; i < valueSize; i++) {
    scale = scale * 256 + (buf[valuePos + i] ?? 0);
  }
  return scale > 0 ? scale : null;
}

function findDurationInInfo(
  buf: Uint8Array,
  dataStart: number,
  dataLen: number,
): number | null {
  const end = Math.min(dataStart + dataLen, buf.length);
  let pos = dataStart;
  let durationInScale: number | null = null;
  let timecodeScaleNs = DEFAULT_TIMECODE_SCALE_NS;

  while (pos + 2 <= end) {
    const idLen = vintLen(buf[pos] ?? 0);
    if (idLen === null || pos + idLen > end) return null;
    const sizeResult = readVint(buf, pos + idLen);
    if (sizeResult === null) return null;

    const elemStart = pos;
    const valuePos = sizeResult.next;
    const valueSize = sizeResult.value;

    if (idLen === 2 && buf[elemStart] === 0x44 && buf[elemStart + 1] === 0x89) {
      const value = readDurationFloat(buf, valuePos, valueSize);
      if (value === null) return null;
      durationInScale = value;
    } else if (
      idLen === 3 &&
      buf[elemStart] === 0x2a &&
      buf[elemStart + 1] === 0xd7 &&
      buf[elemStart + 2] === 0xb1
    ) {
      const scale = readTimecodeScale(buf, valuePos, valueSize);
      if (scale !== null) timecodeScaleNs = scale;
    }

    pos = valuePos + Math.min(valueSize, buf.length - valuePos);
  }

  if (durationInScale === null) return null;
  return Math.ceil((durationInScale * timecodeScaleNs) / 1_000_000_000);
}

function parseWavDuration(buf: Uint8Array): number | null {
  // RIFF header: 44 bytes minimum
  // sampleRate at offset 24 (uint32 LE)
  // numChannels at offset 22 (uint16 LE)
  // bitsPerSample at offset 34 (uint16 LE)
  // data chunk size at offset 40 (uint32 LE)
  if (buf.length < 44) return null;
  if (
    buf[0] !== 0x52 || // 'R'
    buf[1] !== 0x49 || // 'I'
    buf[2] !== 0x46 || // 'F'
    buf[3] !== 0x46 // 'F'
  ) {
    return null;
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const sampleRate = view.getUint32(24, true);
  const numChannels = view.getUint16(22, true);
  const bitsPerSample = view.getUint16(34, true);
  const dataSize = view.getUint32(40, true);

  if (sampleRate === 0 || numChannels === 0 || bitsPerSample === 0) return null;
  const bytesPerSecond = (sampleRate * numChannels * bitsPerSample) / 8;
  if (bytesPerSecond === 0) return null;
  return Math.ceil(dataSize / bytesPerSecond);
}

function estimateDurationFromSize(fileSize: number): number {
  // bytes / (bps / 8) = seconds — floor at 8 kbps gives an upper bound
  return Math.ceil(fileSize / (MIN_SPEECH_BITRATE_BPS / 8));
}

// --- EBML helpers -----------------------------------------------------------

/** Return the length (in bytes) of a vint given its first byte's leading bits. */
function vintLen(firstByte: number): number | null {
  let mask = 0x80;
  for (let i = 1; i <= 8; i++) {
    if (firstByte & mask) return i;
    mask >>= 1;
  }
  return null; // invalid vint (no leading 1 bit)
}

/** Read a vint value and return its size in bytes + parsed value. */
function readVint(
  buf: Uint8Array,
  pos: number,
): { value: number; next: number } | null {
  if (pos >= buf.length) return null;
  const len = vintLen(buf[pos] ?? 0);
  if (len === null || pos + len > buf.length) return null;

  // Clear the leading length bit from the first byte
  let value = (buf[pos] ?? 0) & ((1 << (8 - len)) - 1);
  for (let i = 1; i < len; i++) {
    value = (value << 8) | (buf[pos + i] ?? 0);
  }
  return { value, next: pos + len };
}

// Re-export for use in policy checks
export { MIN_SPEECH_BITRATE_BPS };

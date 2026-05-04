const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04_03_4b_50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02_01_4b_50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06_05_4b_50;
const ZIP_VERSION_NEEDED = 20;
const ZIP_STORE_METHOD = 0;
const ZIP_MAX_UINT32 = 0xff_ff_ff_ff;

type ZipFileEntry = {
  readonly filename: string;
  readonly data: ArrayBuffer | Uint8Array;
  readonly modifiedAt?: Date;
};

type PreparedZipEntry = {
  readonly filenameBytes: Uint8Array;
  readonly data: Uint8Array;
  readonly crc32: number;
  readonly dosDate: number;
  readonly dosTime: number;
  readonly localHeaderOffset: number;
};

export function createZipBlob(entries: readonly ZipFileEntry[]): Blob {
  let offset = 0;
  const crc32Table = createCrc32Table();
  const preparedEntries = entries.map((entry) => {
    const data = toUint8Array(entry.data);
    const filenameBytes = new TextEncoder().encode(normalizeZipFilename(entry));
    assertZipEntrySize(data.byteLength);
    const dosDateTime = toDosDateTime(entry.modifiedAt ?? new Date());
    const prepared: PreparedZipEntry = {
      filenameBytes,
      data,
      crc32: crc32(data, crc32Table),
      dosDate: dosDateTime.date,
      dosTime: dosDateTime.time,
      localHeaderOffset: offset,
    };
    offset += ZIP_LOCAL_FILE_HEADER_SIZE + filenameBytes.byteLength;
    offset += data.byteLength;
    return prepared;
  });

  const localParts = preparedEntries.flatMap((entry) => {
    return [createLocalFileHeader(entry), entry.data];
  });
  const centralDirectoryOffset = offset;
  const centralDirectoryParts = preparedEntries.map((entry) => {
    const header = createCentralDirectoryHeader(entry);
    offset += header.byteLength;
    return header;
  });
  const centralDirectorySize = offset - centralDirectoryOffset;
  const endRecord = createEndOfCentralDirectoryRecord({
    entryCount: preparedEntries.length,
    centralDirectorySize,
    centralDirectoryOffset,
  });

  return new Blob(
    [...localParts, ...centralDirectoryParts, endRecord].map(toArrayBuffer),
    { type: "application/zip" },
  );
}

const ZIP_LOCAL_FILE_HEADER_SIZE = 30;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIZE = 22;

function normalizeZipFilename(entry: ZipFileEntry): string {
  const filename = entry.filename.split(/[\\/]/).pop()?.trim();
  return filename && filename.length > 0 ? filename : "artifact";
}

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function assertZipEntrySize(size: number): void {
  if (size > ZIP_MAX_UINT32) {
    throw new Error("Artifact is too large to include in a zip download");
  }
}

function createLocalFileHeader(entry: PreparedZipEntry): Uint8Array {
  const header = new Uint8Array(
    ZIP_LOCAL_FILE_HEADER_SIZE + entry.filenameBytes.byteLength,
  );
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION_NEEDED, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, ZIP_STORE_METHOD, true);
  view.setUint16(10, entry.dosTime, true);
  view.setUint16(12, entry.dosDate, true);
  view.setUint32(14, entry.crc32, true);
  view.setUint32(18, entry.data.byteLength, true);
  view.setUint32(22, entry.data.byteLength, true);
  view.setUint16(26, entry.filenameBytes.byteLength, true);
  view.setUint16(28, 0, true);
  header.set(entry.filenameBytes, ZIP_LOCAL_FILE_HEADER_SIZE);
  return header;
}

function createCentralDirectoryHeader(entry: PreparedZipEntry): Uint8Array {
  const header = new Uint8Array(
    ZIP_CENTRAL_DIRECTORY_HEADER_SIZE + entry.filenameBytes.byteLength,
  );
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, ZIP_VERSION_NEEDED, true);
  view.setUint16(6, ZIP_VERSION_NEEDED, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, ZIP_STORE_METHOD, true);
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc32, true);
  view.setUint32(20, entry.data.byteLength, true);
  view.setUint32(24, entry.data.byteLength, true);
  view.setUint16(28, entry.filenameBytes.byteLength, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.localHeaderOffset, true);
  header.set(entry.filenameBytes, ZIP_CENTRAL_DIRECTORY_HEADER_SIZE);
  return header;
}

function createEndOfCentralDirectoryRecord(params: {
  readonly entryCount: number;
  readonly centralDirectorySize: number;
  readonly centralDirectoryOffset: number;
}): Uint8Array {
  const header = new Uint8Array(ZIP_END_OF_CENTRAL_DIRECTORY_SIZE);
  const view = new DataView(header.buffer);
  view.setUint32(0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, params.entryCount, true);
  view.setUint16(10, params.entryCount, true);
  view.setUint32(12, params.centralDirectorySize, true);
  view.setUint32(16, params.centralDirectoryOffset, true);
  view.setUint16(20, 0, true);
  return header;
}

function toDosDateTime(date: Date): {
  readonly date: number;
  readonly time: number;
} {
  const year = Math.max(date.getFullYear(), 1980);
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
  };
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(data: Uint8Array, table: Uint32Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of data) {
    crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

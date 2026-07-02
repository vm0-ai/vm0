import {
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
} from "@vm0/api-contracts/contracts/runners";

export { SESSION_HISTORY_ENCODING_GZIP, SESSION_HISTORY_ENCODING_IDENTITY };

export type SessionHistoryBlobEncoding =
  | typeof SESSION_HISTORY_ENCODING_IDENTITY
  | typeof SESSION_HISTORY_ENCODING_GZIP;

export function tryNormalizeSessionHistoryBlobEncoding(
  encoding: string | null,
): SessionHistoryBlobEncoding | undefined {
  if (encoding === null || encoding === SESSION_HISTORY_ENCODING_IDENTITY) {
    return SESSION_HISTORY_ENCODING_IDENTITY;
  }
  if (encoding === SESSION_HISTORY_ENCODING_GZIP) {
    return SESSION_HISTORY_ENCODING_GZIP;
  }
  return undefined;
}

export function normalizeSessionHistoryBlobEncoding(
  encoding: string | null,
): SessionHistoryBlobEncoding {
  const normalized = tryNormalizeSessionHistoryBlobEncoding(encoding);
  if (normalized !== undefined) {
    return normalized;
  }
  throw new Error(`invalid session history blob encoding: ${encoding}`);
}

export function resumeSessionHistoryRawBlobKey(hash: string): string {
  return `blobs/${hash}.blob`;
}

function resumeSessionHistoryGzipBlobKey(hash: string): string {
  return `blobs/${hash}.blob.gz`;
}

export function resumeSessionHistoryBlobKey(
  hash: string,
  encoding: SessionHistoryBlobEncoding,
): string {
  return encoding === SESSION_HISTORY_ENCODING_GZIP
    ? resumeSessionHistoryGzipBlobKey(hash)
    : resumeSessionHistoryRawBlobKey(hash);
}

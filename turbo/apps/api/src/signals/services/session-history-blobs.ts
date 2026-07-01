export const SESSION_HISTORY_ENCODING_IDENTITY = "identity";
export const SESSION_HISTORY_ENCODING_GZIP = "gzip";

export function resumeSessionHistoryRawBlobKey(hash: string): string {
  return `blobs/${hash}.blob`;
}

export function resumeSessionHistoryGzipBlobKey(hash: string): string {
  return `session-history-blobs/${hash}/gzip.blob`;
}

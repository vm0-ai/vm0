export {
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
} from "@vm0/api-contracts/contracts/runners";

export function resumeSessionHistoryRawBlobKey(hash: string): string {
  return `blobs/${hash}.blob`;
}

export function resumeSessionHistoryGzipBlobKey(hash: string): string {
  return `blobs/${hash}.blob.gz`;
}

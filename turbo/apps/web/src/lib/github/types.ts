export interface GitHubUri {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}

export interface DownloadResult {
  filesDownloaded: number;
  bytesDownloaded: number;
  commitSha: string;
}

export interface UploadResult {
  commitSha: string;
  branch: string;
  filesUploaded: number;
}

import { readFile } from "node:fs/promises";

import { completeHostedSite, prepareHostedSite } from "../api";
import { scanStaticSite } from "./static-site";

interface PublishStaticSiteProgress {
  readonly phase: "preparing" | "uploading";
  readonly fileCount?: number;
  readonly path?: string;
}

interface PublishStaticSiteResult {
  readonly siteId: string;
  readonly deploymentId: string;
  readonly publicSlug: string;
  readonly url: string;
  readonly fileCount: number;
  readonly size: number;
}

interface PublishStaticSiteOptions {
  readonly dir: string;
  readonly site: string;
  readonly spaFallback?: boolean;
  readonly onProgress?: (progress: PublishStaticSiteProgress) => void;
}

export async function publishStaticSite(
  options: PublishStaticSiteOptions,
): Promise<PublishStaticSiteResult> {
  const scan = await scanStaticSite(options.dir);
  const totalSize = scan.files.reduce((sum, file) => {
    return sum + file.size;
  }, 0);

  options.onProgress?.({
    phase: "preparing",
    fileCount: scan.files.length,
  });

  const prepared = await prepareHostedSite({
    site: options.site,
    spaFallback: Boolean(options.spaFallback),
    files: scan.files.map((file) => {
      return {
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        contentType: file.contentType,
        immutable: file.immutable,
      };
    }),
  });

  const uploadByPath = new Map(
    prepared.uploads.map((upload) => {
      return [upload.path, upload.uploadUrl];
    }),
  );

  for (const file of scan.files) {
    const uploadUrl = uploadByPath.get(file.path);
    if (!uploadUrl) {
      throw new Error(`Missing upload URL for ${file.path}`);
    }
    options.onProgress?.({ phase: "uploading", path: file.path });
    const bytes = await readFile(file.absolutePath);
    const response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.contentType },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      throw new Error(
        `Failed to upload ${file.path} (HTTP ${response.status})`,
      );
    }
  }

  const completed = await completeHostedSite(prepared.deploymentId);

  return {
    siteId: completed.siteId,
    deploymentId: completed.deploymentId,
    publicSlug: completed.publicSlug,
    url: completed.url,
    fileCount: scan.files.length,
    size: totalSize,
  };
}

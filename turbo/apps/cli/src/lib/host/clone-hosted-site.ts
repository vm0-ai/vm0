import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { HostedSiteFilesResponse } from "@vm0/api-contracts/contracts/zero-host";
import { getHostedSiteFiles } from "../api";
import { checkDirectoryStatus } from "../utils/file-utils";

interface CloneHostedSiteProgress {
  readonly phase: "checking" | "creating" | "downloading";
  readonly fileCount?: number;
  readonly path?: string;
}

interface CloneHostedSiteResult {
  readonly siteId: string;
  readonly deploymentId: string;
  readonly publicSlug: string;
  readonly url: string;
  readonly destination: string;
  readonly fileCount: number;
  readonly size: number;
}

interface CloneHostedSiteOptions {
  readonly site: string;
  readonly destination: string;
  readonly onProgress?: (progress: CloneHostedSiteProgress) => void;
}

export function publicSlugFromSite(value: string): string {
  const trimmed = value.trim();
  if (URL.canParse(trimmed)) {
    const url = new URL(trimmed);
    return url.hostname.split(".")[0] ?? trimmed;
  }
  if (trimmed.includes(".")) {
    return trimmed.split(".")[0] ?? trimmed;
  }
  return trimmed;
}

function isInsideDirectory(parent: string, target: string): boolean {
  const relativePath = relative(parent, target);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

function outputPathForHostedFile(
  destination: string,
  hostedPath: string,
): string {
  if (
    !hostedPath.startsWith("/") ||
    hostedPath.startsWith("//") ||
    hostedPath.includes("\\") ||
    hostedPath.includes("\0")
  ) {
    throw new Error(`Invalid hosted-site path: ${hostedPath}`);
  }

  const segments = hostedPath.split("/").filter((segment) => {
    return segment.length > 0;
  });
  if (
    segments.length === 0 ||
    segments.some((segment) => {
      return segment === "." || segment === "..";
    })
  ) {
    throw new Error(`Invalid hosted-site path: ${hostedPath}`);
  }

  const destinationRoot = resolve(destination);
  const outputPath = resolve(destinationRoot, ...segments);
  if (!isInsideDirectory(destinationRoot, outputPath)) {
    throw new Error(`Invalid hosted-site path: ${hostedPath}`);
  }

  return outputPath;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function downloadHostedFile(
  file: HostedSiteFilesResponse["files"][number],
  siteUrl: string,
  destination: string,
): Promise<void> {
  const response = await fetch(new URL(file.path, siteUrl));
  if (!response.ok) {
    throw new Error(
      `Failed to download ${file.path} (HTTP ${response.status})`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== file.size) {
    throw new Error(`Downloaded size mismatch for ${file.path}`);
  }
  if (sha256(bytes) !== file.sha256) {
    throw new Error(`Downloaded hash mismatch for ${file.path}`);
  }

  const outputPath = outputPathForHostedFile(destination, file.path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
}

export async function cloneHostedSite(
  options: CloneHostedSiteOptions,
): Promise<CloneHostedSiteResult> {
  const publicSlug = publicSlugFromSite(options.site);
  const dirStatus = checkDirectoryStatus(options.destination);
  if (dirStatus.exists && !dirStatus.empty) {
    throw new Error(`Directory "${options.destination}" is not empty`);
  }

  options.onProgress?.({ phase: "checking" });
  const hostedSite = await getHostedSiteFiles(publicSlug);

  options.onProgress?.({
    phase: "creating",
    fileCount: hostedSite.fileCount,
  });
  await mkdir(options.destination, { recursive: true });

  for (const file of hostedSite.files) {
    options.onProgress?.({ phase: "downloading", path: file.path });
    await downloadHostedFile(file, hostedSite.url, options.destination);
  }

  return {
    siteId: hostedSite.siteId,
    deploymentId: hostedSite.deploymentId,
    publicSlug: hostedSite.publicSlug,
    url: hostedSite.url,
    destination: options.destination,
    fileCount: hostedSite.fileCount,
    size: hostedSite.size,
  };
}

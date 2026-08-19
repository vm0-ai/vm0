import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";

import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

/**
 * The signed URL points straight at private storage, so it is fetched without
 * the CLI's auth headers.
 */
async function downloadSignedUrl(url: string, outPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new ApiRequestError(
      `Failed to download ${outPath} (HTTP ${response.status.toString()})`,
      "DOWNLOAD_FAILED",
      response.status,
    );
  }
  if (!response.body) {
    throw new ApiRequestError(
      `Download response for ${outPath} has no body`,
      "EMPTY_BODY",
      502,
    );
  }
  await mkdir(dirname(outPath), { recursive: true });
  // Cast required: Web and Node ReadableStream declarations are incompatible.
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(outPath),
  );
}

export async function pullPresentationTemplateSource(
  templateId: string,
  outPath: string,
): Promise<{ readonly path: string; readonly filename: string }> {
  const config = await getClientConfig();
  const client = initClient(presentationTemplatesContract, config);
  const result = await client.source({ params: { templateId } });
  if (result.status !== 200) {
    handleError(result, "Failed to resolve the template source download");
  }
  await downloadSignedUrl(result.body.url, outPath);
  return { path: outPath, filename: result.body.filename };
}

/**
 * Pages land in a scratch directory and are moved into place only once every
 * one has been written, so an interrupted pull leaves no partial page set.
 */
export async function pullPresentationTemplatePages(
  templateId: string,
  outDir: string,
): Promise<readonly string[]> {
  const config = await getClientConfig();
  const client = initClient(presentationTemplatesContract, config);
  const result = await client.pages({ params: { templateId } });
  if (result.status !== 200) {
    handleError(result, "Failed to resolve the template page downloads");
  }

  const pages = [...result.body.pages].sort((left, right) => {
    return left.index - right.index;
  });
  const missing = pages.findIndex((page, index) => {
    return page.index !== index;
  });
  if (missing !== -1) {
    throw new ApiRequestError(
      `Template page ${(missing + 1).toString()} is missing from the ordered set`,
      "INCOMPLETE_PAGES",
      502,
    );
  }

  const staging = join(outDir, ".partial");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const page of pages) {
    await downloadSignedUrl(page.url, join(staging, page.filename));
  }

  const written: string[] = [];
  for (const page of pages) {
    const target = join(outDir, page.filename);
    await rename(join(staging, page.filename), target);
    written.push(target);
  }
  await rm(staging, { recursive: true, force: true });
  return written;
}

export async function failPresentationTemplateImport(
  templateId: string,
  body: { readonly code: "analysis_failed"; readonly message: string },
): Promise<{ readonly id: string; readonly status: string }> {
  const config = await getClientConfig();
  const client = initClient(presentationTemplatesContract, config);
  const result = await client.fail({ params: { templateId }, body });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to report the template analysis failure");
}

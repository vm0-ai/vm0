import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  initClient,
  type ServerInferRequest,
  type ServerInferResponseBody,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { zeroPresentationTemplatesContract } from "@okouai/api-contracts/contracts/zero-presentation-templates";

import {
  ApiRequestError,
  getClientConfig,
  handleError,
} from "../core/client-factory";

type PresentationTemplateSource = ServerInferResponseBody<
  typeof zeroPresentationTemplatesContract.source,
  200
>;
type PreparedPresentationTemplatePages = ServerInferResponseBody<
  typeof zeroPresentationTemplatesContract.preparePages,
  200
>;
type PreparedPresentationTemplatePage =
  PreparedPresentationTemplatePages["uploads"][number];
type CommitPresentationTemplatePagesBody = ServerInferRequest<
  typeof zeroPresentationTemplatesContract.commitPages
>["body"];
type PublishPresentationTemplatePackageBody = ServerInferRequest<
  typeof zeroPresentationTemplatesContract.publishPackage
>["body"];
export type FailPresentationTemplateImportBody = ServerInferRequest<
  typeof zeroPresentationTemplatesContract.fail
>["body"];

async function client() {
  return initClient(zeroPresentationTemplatesContract, await getClientConfig());
}

async function getPresentationTemplateSource(
  templateId: string,
): Promise<PresentationTemplateSource> {
  const result = await (
    await client()
  ).source({
    params: { templateId },
    headers: {},
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to prepare presentation template source");
}

export async function downloadPresentationTemplateSource(
  templateId: string,
  outPath: string,
): Promise<PresentationTemplateSource> {
  const source = await getPresentationTemplateSource(templateId);
  const response = await fetch(source.url);
  if (!response.ok) {
    throw new ApiRequestError(
      `Failed to download presentation template source (HTTP ${response.status.toString()})`,
      "DOWNLOAD_FAILED",
      response.status,
    );
  }
  if (!response.body) {
    throw new ApiRequestError(
      "Presentation template source response has no body",
      "EMPTY_BODY",
      502,
    );
  }

  const partialPath = `${outPath}.partial-${randomUUID()}`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(partialPath, { flags: "wx" }),
    );
    const downloaded = await stat(partialPath);
    if (downloaded.size !== source.size) {
      throw new ApiRequestError(
        `Presentation template source size mismatch: expected ${source.size.toString()} bytes, received ${downloaded.size.toString()}`,
        "INVALID_RESPONSE",
        502,
      );
    }
    await rename(partialPath, outPath);
  } finally {
    await rm(partialPath, { force: true });
  }
  return source;
}

export async function preparePresentationTemplatePages(
  templateId: string,
  count: number,
): Promise<PreparedPresentationTemplatePages> {
  const result = await (
    await client()
  ).preparePages({
    params: { templateId },
    headers: {},
    body: { count },
  });
  if (result.status === 200) {
    return result.body;
  }
  handleError(result, "Failed to prepare presentation template page uploads");
}

export async function uploadPresentationTemplatePage(
  upload: PreparedPresentationTemplatePage,
  bytes: Uint8Array,
): Promise<void> {
  const response = await fetch(upload.uploadUrl, {
    method: "PUT",
    headers: {
      ...upload.uploadHeaders,
      "Content-Type": "image/png",
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new ApiRequestError(
      `Failed to upload presentation template page (HTTP ${response.status.toString()})`,
      "UPLOAD_FAILED",
      response.status,
    );
  }
}

export async function commitPresentationTemplatePages(
  templateId: string,
  body: CommitPresentationTemplatePagesBody,
): Promise<void> {
  const result = await (
    await client()
  ).commitPages({
    params: { templateId },
    headers: {},
    body,
  });
  if (result.status === 200) {
    return;
  }
  handleError(result, "Failed to commit presentation template pages");
}

export async function publishPresentationTemplatePackage(
  templateId: string,
  body: PublishPresentationTemplatePackageBody,
): Promise<void> {
  const result = await (
    await client()
  ).publishPackage({
    params: { templateId },
    headers: {},
    body,
  });
  if (result.status === 200) {
    return;
  }
  handleError(result, "Failed to publish presentation template package");
}

export async function failPresentationTemplateImport(
  templateId: string,
  body: FailPresentationTemplateImportBody,
): Promise<void> {
  const result = await (
    await client()
  ).fail({
    params: { templateId },
    headers: {},
    body,
  });
  if (result.status === 200) {
    return;
  }
  handleError(result, "Failed to report presentation template import failure");
}

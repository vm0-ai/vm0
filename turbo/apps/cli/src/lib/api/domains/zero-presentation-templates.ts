import {
  type PresentationTemplateImportErrorCode,
  type PresentationTemplatePackagePath,
  zeroPresentationTemplatesContract,
} from "@vm0/api-contracts/contracts/zero-presentation-templates";
import { initClient } from "@vm0/api-contracts/contracts/trpc-contract";

import { getClientConfig, handleError } from "../core/client-factory";

interface PresentationTemplatePackageFile {
  readonly path: PresentationTemplatePackagePath;
  readonly content: string;
}

async function presentationTemplateClient() {
  return initClient(zeroPresentationTemplatesContract, await getClientConfig());
}

export async function getPresentationTemplateSource(templateId: string) {
  const client = await presentationTemplateClient();
  const result = await client.source({ params: { templateId } });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to prepare presentation template source");
}

export async function preparePresentationTemplatePages(
  templateId: string,
  count: number,
) {
  const client = await presentationTemplateClient();
  const result = await client.preparePages({
    params: { templateId },
    body: { count },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to prepare presentation template page uploads");
}

export async function commitPresentationTemplatePages(
  templateId: string,
  keys: string[],
) {
  const client = await presentationTemplateClient();
  const result = await client.commitPages({
    params: { templateId },
    body: { keys, aspectRatio: 16 / 9 },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to commit presentation template pages");
}

export async function publishPresentationTemplatePackage(
  templateId: string,
  files: PresentationTemplatePackageFile[],
) {
  const client = await presentationTemplateClient();
  const result = await client.publishPackage({
    params: { templateId },
    body: { files },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to publish presentation template package");
}

export async function failPresentationTemplateImport(
  templateId: string,
  code: PresentationTemplateImportErrorCode,
  message: string,
) {
  const client = await presentationTemplateClient();
  const result = await client.fail({
    params: { templateId },
    body: { code, message },
  });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to report presentation template import failure");
}

export async function getPresentationTemplatePackage(templateId: string) {
  const client = await presentationTemplateClient();
  const result = await client.downloadPackage({ params: { templateId } });
  if (result.status === 200) return result.body;
  handleError(result, "Failed to prepare presentation template package");
}

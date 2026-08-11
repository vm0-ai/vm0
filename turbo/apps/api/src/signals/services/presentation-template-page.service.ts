import { command } from "ccstate";

import { env } from "../../lib/env";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";

const PAGE_OBJECT_ROOT = "artifacts/presentation-template-pages";

export const PRESENTATION_TEMPLATE_PAGE_CONTENT_TYPE = "image/png";

export function presentationTemplatePageFilename(index: number): string {
  return `page-${(index + 1).toString().padStart(3, "0")}.png`;
}

function presentationTemplatePagePrefix(templateId: string): string {
  return `${PAGE_OBJECT_ROOT}/${templateId}`;
}

export function presentationTemplatePageKey(
  templateId: string,
  index: number,
): string {
  return `${presentationTemplatePagePrefix(templateId)}/${presentationTemplatePageFilename(index)}`;
}

export function isPresentationTemplatePageKey(
  templateId: string,
  index: number,
  key: string,
): boolean {
  return key === presentationTemplatePageKey(templateId, index);
}

export const listPresentationTemplatePageKeys$ = command(
  async (
    { get },
    templateId: string,
    signal: AbortSignal,
  ): Promise<readonly string[]> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const prefixedObjects = await get(
      listS3ObjectsUnderPrefix(
        bucket,
        presentationTemplatePagePrefix(templateId),
      ),
    );
    signal.throwIfAborted();
    return prefixedObjects.map((object) => {
      return object.key;
    });
  },
);

export const deletePresentationTemplatePageKeys$ = command(
  async (
    { get },
    args: {
      readonly keys: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    await get(deleteS3Objects(bucket, args.keys));
    signal.throwIfAborted();
  },
);

export const deletePresentationTemplatePages$ = command(
  async (
    { set },
    args: {
      readonly templateId: string;
      readonly storedKeys: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const prefixedKeys = await set(
      listPresentationTemplatePageKeys$,
      args.templateId,
      signal,
    );
    await set(
      deletePresentationTemplatePageKeys$,
      { keys: [...new Set([...args.storedKeys, ...prefixedKeys])] },
      signal,
    );
  },
);

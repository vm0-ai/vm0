import { command } from "ccstate";
import { MAX_PRESENTATION_TEMPLATE_PAGES } from "@vm0/api-contracts/contracts/zero-presentation-templates";

import { env } from "../../lib/env";
import { buildArtifactKeyV2 } from "../../lib/file-url";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";

const PAGE_OBJECT_ROOT = "artifacts/presentation-template-pages";
const LEGACY_ARTIFACT_KEY_ATTEMPTS = 5;

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

function legacyCollisionVariant(variant: string, attempt: number): string {
  return attempt === 0 ? variant : `${variant}\0${attempt.toString()}`;
}

/**
 * Old API instances allocated flat, hash-based artifact keys. Existing import
 * runners can keep those prepared keys for up to two hours, so new commit and
 * cleanup paths accept every key the old five-attempt allocator could mint.
 * Remove this compatibility set after the pre-#26301 runner skew window ends.
 */
function legacyPresentationTemplatePageKeys(
  templateId: string,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (let index = 0; index < MAX_PRESENTATION_TEMPLATE_PAGES; index += 1) {
    const variant = `page-${index.toString()}`;
    const filename = presentationTemplatePageFilename(index);
    for (
      let attempt = 0;
      attempt < LEGACY_ARTIFACT_KEY_ATTEMPTS;
      attempt += 1
    ) {
      keys.add(
        buildArtifactKeyV2(
          templateId,
          filename,
          legacyCollisionVariant(variant, attempt),
        ),
      );
    }
  }
  return keys;
}

export function isPresentationTemplatePageKey(
  templateId: string,
  index: number,
  key: string,
): boolean {
  if (key === presentationTemplatePageKey(templateId, index)) {
    return true;
  }
  const variant = `page-${index.toString()}`;
  const filename = presentationTemplatePageFilename(index);
  for (let attempt = 0; attempt < LEGACY_ARTIFACT_KEY_ATTEMPTS; attempt += 1) {
    if (
      key ===
      buildArtifactKeyV2(
        templateId,
        filename,
        legacyCollisionVariant(variant, attempt),
      )
    ) {
      return true;
    }
  }
  return false;
}

export const deletePresentationTemplatePages$ = command(
  async (
    { get },
    args: {
      readonly templateId: string;
      readonly storedKeys: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    const prefixedObjects = await get(
      listS3ObjectsUnderPrefix(
        bucket,
        presentationTemplatePagePrefix(args.templateId),
      ),
    );
    signal.throwIfAborted();
    const keys = new Set([
      ...args.storedKeys,
      ...prefixedObjects.map((object) => {
        return object.key;
      }),
      ...legacyPresentationTemplatePageKeys(args.templateId),
    ]);
    await get(deleteS3Objects(bucket, [...keys]));
    signal.throwIfAborted();
  },
);

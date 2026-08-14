import { command } from "ccstate";

import { env } from "../../lib/env";
import { deleteS3Objects, listS3ObjectsUnderPrefix } from "../external/s3";

const OBJECT_ROOT = "presentation-template-ingestions";
const TEMPLATE_ID_METADATA = "presentation-template-id";
const OWNER_USER_ID_METADATA = "presentation-template-owner";
const OBJECT_KIND_METADATA = "presentation-template-kind";
const PAGE_INDEX_METADATA = "presentation-template-page-index";
const EXPECTED_SIZE_METADATA = "presentation-template-size";
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function presentationTemplateObjectPrefix(templateId: string): string {
  return `${OBJECT_ROOT}/${templateId}`;
}

function presentationTemplateUploadPrefix(
  templateId: string,
  uploadId: string,
): string {
  return `${presentationTemplateObjectPrefix(templateId)}/uploads/${uploadId}`;
}

export function presentationTemplateSourceKey(
  templateId: string,
  uploadId: string,
): string {
  return `${presentationTemplateUploadPrefix(templateId, uploadId)}/source/source.pptx`;
}

export function presentationTemplatePageFilename(index: number): string {
  return `page-${(index + 1).toString().padStart(3, "0")}.png`;
}

export function presentationTemplatePagePrefix(
  templateId: string,
  uploadId: string,
): string {
  return `${presentationTemplateUploadPrefix(templateId, uploadId)}/pages`;
}

export function presentationTemplatePageKey(
  templateId: string,
  uploadId: string,
  index: number,
): string {
  return `${presentationTemplatePagePrefix(templateId, uploadId)}/${presentationTemplatePageFilename(index)}`;
}

export function presentationTemplateUploadIdFromManifest(args: {
  readonly templateId: string;
  readonly sourceKey: string;
  readonly pageKeys: readonly string[];
}): string | null {
  const uploadRoot = `${presentationTemplateObjectPrefix(args.templateId)}/uploads/`;
  const sourceSuffix = "/source/source.pptx";
  if (
    !args.sourceKey.startsWith(uploadRoot) ||
    !args.sourceKey.endsWith(sourceSuffix)
  ) {
    return null;
  }
  const uploadId = args.sourceKey.slice(
    uploadRoot.length,
    args.sourceKey.length - sourceSuffix.length,
  );
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return null;
  }
  return args.pageKeys.every((key, index) => {
    return (
      key === presentationTemplatePageKey(args.templateId, uploadId, index)
    );
  })
    ? uploadId
    : null;
}

function baseMetadata(args: {
  readonly templateId: string;
  readonly ownerUserId: string;
  readonly kind: "source" | "page";
  readonly size: number;
}): Record<string, string> {
  return {
    [TEMPLATE_ID_METADATA]: args.templateId,
    [OWNER_USER_ID_METADATA]: encodeURIComponent(args.ownerUserId),
    [OBJECT_KIND_METADATA]: args.kind,
    [EXPECTED_SIZE_METADATA]: args.size.toString(),
  };
}

export function presentationTemplateSourceMetadata(args: {
  readonly templateId: string;
  readonly ownerUserId: string;
  readonly size: number;
}): Readonly<Record<string, string>> {
  return baseMetadata({ ...args, kind: "source" });
}

export function presentationTemplatePageMetadata(args: {
  readonly templateId: string;
  readonly ownerUserId: string;
  readonly index: number;
  readonly size: number;
}): Readonly<Record<string, string>> {
  return {
    ...baseMetadata({ ...args, kind: "page" }),
    [PAGE_INDEX_METADATA]: args.index.toString(),
  };
}

export function hasExpectedPresentationTemplateMetadata(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([name, value]) => {
    return actual[name] === value;
  });
}

export const deletePresentationTemplateObjects$ = command(
  async ({ get }, templateId: string, signal: AbortSignal): Promise<void> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    const objects = await get(
      listS3ObjectsUnderPrefix(
        bucket,
        presentationTemplateObjectPrefix(templateId),
      ),
    );
    signal.throwIfAborted();
    await get(
      deleteS3Objects(
        bucket,
        objects.map((object) => {
          return object.key;
        }),
      ),
    );
    signal.throwIfAborted();
  },
);

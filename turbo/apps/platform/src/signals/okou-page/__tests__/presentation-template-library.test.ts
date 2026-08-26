import { describe, expect, it } from "vitest";

import { evictImportedPresentationTemplateCache } from "../presentation-template-library.ts";

type ImportedPresentationTemplateCache = Parameters<
  typeof evictImportedPresentationTemplateCache
>[0];

function previewAsset(previewAssetId: string) {
  return {
    previewAssetId,
    url: `https://example.com/${previewAssetId}.png`,
    expiresAt: "2026-08-26T03:15:00.000Z",
  };
}

describe("presentation template library cache", () => {
  it("evicts a deleted template and only its unreferenced preview URLs", () => {
    const deletedTemplateId = "deleted-template";
    const remainingTemplateId = "remaining-template";
    const deletedPreviewAssetId = "deleted-preview";
    const sharedPreviewAssetId = "shared-preview";
    const remainingPreviewAssetId = "remaining-preview";
    const cache: ImportedPresentationTemplateCache = {
      detailByTemplateId: new Map([
        [
          deletedTemplateId,
          {
            kind: "preview-assets",
            previewAssetIds: [deletedPreviewAssetId, sharedPreviewAssetId],
          },
        ],
        [
          remainingTemplateId,
          {
            kind: "preview-assets",
            previewAssetIds: [sharedPreviewAssetId, remainingPreviewAssetId],
          },
        ],
      ]),
      previewUrlByAssetId: new Map(
        [
          deletedPreviewAssetId,
          sharedPreviewAssetId,
          remainingPreviewAssetId,
        ].map((previewAssetId) => {
          return [previewAssetId, previewAsset(previewAssetId)];
        }),
      ),
    };

    evictImportedPresentationTemplateCache(cache, deletedTemplateId);

    expect([...cache.detailByTemplateId.keys()]).toStrictEqual([
      remainingTemplateId,
    ]);
    expect([...cache.previewUrlByAssetId.keys()]).toStrictEqual([
      sharedPreviewAssetId,
      remainingPreviewAssetId,
    ]);
  });
});

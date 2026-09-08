import {
  presentationTemplatesContract,
  type PresentationTemplateCatalogEntry,
  type PresentationTemplateDetail,
  type PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { mockApi } from "../msw-contract.ts";

/**
 * A signed-in user has imported nothing until a test says otherwise, which is
 * also what the picker shows for everyone who has never used the feature.
 */
let mockPresentationTemplates: PresentationTemplateDetail[] = [];

function summary(
  template: PresentationTemplateDetail,
): PresentationTemplateSummary {
  const {
    pageUrls: _pageUrls,
    previewAssets: _previewAssets,
    ...templateSummary
  } = template;
  return templateSummary;
}

function catalogEntry(
  template: PresentationTemplateDetail,
): PresentationTemplateCatalogEntry {
  const { pageUrls: _pageUrls, ...entry } = template;
  return entry;
}

function notFound(templateId: string) {
  return {
    error: {
      code: "NOT_FOUND" as const,
      message: `Presentation template not found: ${templateId}`,
    },
  };
}

export function resetMockPresentationTemplates(): void {
  mockPresentationTemplates = [];
}

export const apiPresentationTemplatesHandlers = [
  mockApi(presentationTemplatesContract.list, ({ respond }) => {
    return respond(200, mockPresentationTemplates.map(catalogEntry));
  }),
  mockApi(presentationTemplatesContract.get, ({ params, respond }) => {
    const template = mockPresentationTemplates.find((candidate) => {
      return candidate.id === params.templateId;
    });
    return template
      ? respond(200, template)
      : respond(404, notFound(params.templateId));
  }),
  mockApi(
    presentationTemplatesContract.resolvePreviewUrls,
    ({ body, respond }) => {
      const requestedPreviewAssetIds = new Set(body.previewAssetIds);
      const assets = mockPresentationTemplates.flatMap((template) => {
        return template.previewAssets.filter((asset) => {
          return requestedPreviewAssetIds.has(asset.previewAssetId);
        });
      });
      return respond(200, { assets });
    },
  ),
  mockApi(presentationTemplatesContract.update, ({ body, params, respond }) => {
    const index = mockPresentationTemplates.findIndex((candidate) => {
      return candidate.id === params.templateId;
    });
    if (index === -1) {
      return respond(404, notFound(params.templateId));
    }
    const current = mockPresentationTemplates[index]!;
    const updated: PresentationTemplateDetail = {
      ...current,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
      updatedAt: new Date().toISOString(),
    };
    mockPresentationTemplates[index] = updated;
    return respond(200, summary(updated));
  }),
  mockApi(presentationTemplatesContract.delete, ({ params, respond }) => {
    const template = mockPresentationTemplates.find((candidate) => {
      return candidate.id === params.templateId;
    });
    if (!template) {
      return respond(404, notFound(params.templateId));
    }
    mockPresentationTemplates = mockPresentationTemplates.filter(
      (candidate) => {
        return candidate.id !== params.templateId;
      },
    );
    return respond(204);
  }),
];

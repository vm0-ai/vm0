import {
  presentationTemplatesContract,
  PRESENTATION_TEMPLATE_URL_TTL_SECONDS,
  type PresentationTemplateCatalogEntry,
  type PresentationTemplateDetail,
  type PresentationTemplatePreviewAsset,
  type PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { now } from "../../lib/time.ts";
import { mockApi } from "../msw-contract.ts";

/**
 * A signed-in user has imported nothing until a test says otherwise, which is
 * also what the picker shows for everyone who has never used the feature.
 */
let mockPresentationTemplates: PresentationTemplateDetail[] = [];

type MockPresentationTemplateDetail = Omit<
  PresentationTemplateDetail,
  "previewAssets"
> & {
  readonly previewAssets?: readonly PresentationTemplatePreviewAsset[];
};

function detail(
  template: MockPresentationTemplateDetail,
): PresentationTemplateDetail {
  return {
    ...template,
    previewAssets:
      template.previewAssets === undefined
        ? template.pageUrls.map((url, index) => {
            return {
              previewAssetId: `ptp:${template.id}:mock-${index.toString()}`,
              url,
              expiresAt: new Date(
                now() + PRESENTATION_TEMPLATE_URL_TTL_SECONDS * 1000,
              ).toISOString(),
            };
          })
        : [...template.previewAssets],
  };
}

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

export function setMockPresentationTemplates(
  templates: readonly MockPresentationTemplateDetail[],
): void {
  mockPresentationTemplates = templates.map(detail);
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

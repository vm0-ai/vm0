import {
  presentationTemplatesContract,
  type PresentationTemplateSummary,
} from "@okouai/api-contracts/contracts/presentation-templates";

import { mockApi } from "../msw-contract.ts";

/**
 * A signed-in user has imported nothing until a test says otherwise, which is
 * also what the picker shows for everyone who has never used the feature.
 */
let mockOwnPresentationTemplates: PresentationTemplateSummary[] = [];

export function resetMockPresentationTemplates(): void {
  mockOwnPresentationTemplates = [];
}

export function setMockPresentationTemplates(
  templates: readonly PresentationTemplateSummary[],
): void {
  mockOwnPresentationTemplates = [...templates];
}

export const apiPresentationTemplatesHandlers = [
  mockApi(presentationTemplatesContract.list, ({ respond }) => {
    return respond(200, [...mockOwnPresentationTemplates]);
  }),
];

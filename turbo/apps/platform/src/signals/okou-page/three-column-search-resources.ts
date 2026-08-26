import { computed } from "ccstate";
import {
  artifactCatalogContract,
  type ArtifactSummary,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { allVisibleWorkflows$ } from "../workflows-page/workflows-signals.ts";
import { chatListQuery$ } from "./sidebar-state.ts";

const MAX_RESOURCE_SEARCH_RESULTS = 25;

interface ThreeColumnWorkflowSearchResult {
  readonly query: string;
  readonly workflows: readonly WorkflowSummary[];
}

interface ThreeColumnArtifactSearchResult {
  readonly query: string;
  readonly artifacts: readonly ArtifactSummary[];
}

function workflowMatchesQuery(
  workflow: WorkflowSummary,
  query: string,
): boolean {
  return [workflow.displayName, workflow.name, workflow.description].some(
    (value) => {
      return value?.toLowerCase().includes(query) ?? false;
    },
  );
}

export const threeColumnWorkflowSearchResults$ = computed(
  async (get): Promise<ThreeColumnWorkflowSearchResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (!query) {
      return { query, workflows: [] };
    }
    const workflows = await get(allVisibleWorkflows$);
    return {
      query,
      workflows: workflows
        .filter((workflow) => {
          return workflowMatchesQuery(workflow, query);
        })
        .slice(0, MAX_RESOURCE_SEARCH_RESULTS),
    };
  },
);

export const threeColumnArtifactSearchResults$ = computed(
  async (get): Promise<ThreeColumnArtifactSearchResult> => {
    const query = get(chatListQuery$).trim().toLowerCase();
    if (!query) {
      return { query, artifacts: [] };
    }
    const client = get(apiClient$)(artifactCatalogContract);
    const result = await accept(
      client.list({
        query: { keyword: query, limit: MAX_RESOURCE_SEARCH_RESULTS },
      }),
      [200],
    );
    return {
      query,
      // An older API may ignore the additive keyword parameter during rollout.
      // Filtering the response keeps mixed frontend/API versions correct.
      artifacts: result.body.artifacts.filter((artifact) => {
        return artifact.title.toLowerCase().includes(query);
      }),
    };
  },
);

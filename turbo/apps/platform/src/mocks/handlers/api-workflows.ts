import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  type ZeroWorkflowContentResponse,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { mockApi } from "../msw-contract.ts";

const DEFAULT_WORKFLOWS: ZeroWorkflowDetailResponse[] = [];

let mockWorkflows: ZeroWorkflowDetailResponse[] = [...DEFAULT_WORKFLOWS];

function metadata(workflow: ZeroWorkflowDetailResponse): ZeroWorkflowSummary {
  return {
    name: workflow.name,
    displayName: workflow.displayName,
    description: workflow.description,
    visibility: workflow.visibility,
    ownerUserId: workflow.ownerUserId,
    attachedAgentCount: workflow.attachedAgentCount,
    attachedAgents: workflow.attachedAgents,
    canManage: workflow.canManage,
  };
}

export function resetMockWorkflows(): void {
  mockWorkflows = [...DEFAULT_WORKFLOWS];
}

export const apiWorkflowsHandlers = [
  mockApi(zeroWorkflowsCollectionContract.list, ({ respond }) => {
    return respond(200, mockWorkflows.map(metadata));
  }),

  mockApi(zeroWorkflowsDetailContract.get, ({ params, respond }) => {
    const workflow = mockWorkflows.find((item) => {
      return item.name === params.name;
    });
    if (!workflow) {
      return respond(404, {
        error: {
          message: `Workflow not found: ${params.name}`,
          code: "NOT_FOUND",
        },
      });
    }
    return respond(200, workflow);
  }),

  mockApi(zeroWorkflowsDetailContract.update, ({ body, params, respond }) => {
    const index = mockWorkflows.findIndex((item) => {
      return item.name === params.name;
    });
    if (index === -1) {
      return respond(404, {
        error: {
          message: `Workflow not found: ${params.name}`,
          code: "NOT_FOUND",
        },
      });
    }

    const existing = mockWorkflows[index]!;
    const files = body.files ?? existing.fileContents ?? [];
    const skillFile = files.find((file) => {
      return file.path === "SKILL.md";
    });
    const response: ZeroWorkflowContentResponse = {
      ...existing,
      visibility: body.visibility ?? existing.visibility,
      content: skillFile?.content ?? null,
      files: files.map((file) => {
        return {
          path: file.path,
          size: new TextEncoder().encode(file.content).length,
        };
      }),
    };
    const updated: ZeroWorkflowDetailResponse = {
      ...response,
      fileContents: files,
    };
    mockWorkflows[index] = updated;
    return respond(200, response);
  }),
];

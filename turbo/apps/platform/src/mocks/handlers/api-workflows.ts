import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  zeroWorkflowVisibilityContract,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { mockApi } from "../msw-contract.ts";

const DEFAULT_WORKFLOWS: ZeroWorkflowDetailResponse[] = [];

let mockWorkflows: ZeroWorkflowDetailResponse[] = [...DEFAULT_WORKFLOWS];

function notFound(workflowId: string) {
  return {
    error: { message: `Workflow not found: ${workflowId}`, code: "NOT_FOUND" },
  };
}

function summary(workflow: ZeroWorkflowDetailResponse): ZeroWorkflowSummary {
  return {
    id: workflow.id,
    agentId: workflow.agentId,
    agentName: workflow.agentName,
    agentDisplayName: workflow.agentDisplayName,
    name: workflow.name,
    displayName: workflow.displayName,
    description: workflow.description,
    visibility: workflow.visibility,
    requestToPublish: workflow.requestToPublish,
    ownerUserId: workflow.ownerUserId,
    canManage: workflow.canManage,
  };
}

export function resetMockWorkflows(): void {
  mockWorkflows = [...DEFAULT_WORKFLOWS];
}

export const apiWorkflowsHandlers = [
  mockApi(zeroWorkflowsCollectionContract.list, ({ query, respond }) => {
    const agentId = query.agentId;
    const visible = agentId
      ? mockWorkflows.filter((workflow) => {
          return workflow.agentId === agentId;
        })
      : mockWorkflows;
    return respond(200, visible.map(summary));
  }),

  mockApi(zeroWorkflowsCollectionContract.create, ({ body, respond }) => {
    const created: ZeroWorkflowDetailResponse = {
      id: crypto.randomUUID(),
      agentId: body.agentId,
      agentName: null,
      agentDisplayName: null,
      name: body.name,
      displayName: body.displayName ?? null,
      description: body.description ?? null,
      visibility: body.visibility ?? "private",
      requestToPublish: false,
      ownerUserId: "test-user-123",
      canManage: true,
      instruction: body.instruction ?? null,
      files: (body.files ?? []).map((file) => {
        return {
          path: file.path,
          size: new TextEncoder().encode(file.content).length,
        };
      }),
      fileContents: body.files ?? [],
      triggers: [],
    };
    mockWorkflows = [...mockWorkflows, created];
    return respond(201, summary(created));
  }),

  mockApi(zeroWorkflowsDetailContract.get, ({ params, respond }) => {
    const workflow = mockWorkflows.find((item) => {
      return item.id === params.workflowId;
    });
    if (!workflow) {
      return respond(404, notFound(params.workflowId));
    }
    return respond(200, workflow);
  }),

  mockApi(zeroWorkflowsDetailContract.update, ({ body, params, respond }) => {
    const index = mockWorkflows.findIndex((item) => {
      return item.id === params.workflowId;
    });
    if (index === -1) {
      return respond(404, notFound(params.workflowId));
    }

    const existing = mockWorkflows[index]!;
    const files = body.files ?? existing.fileContents ?? [];
    const updated: ZeroWorkflowDetailResponse = {
      ...existing,
      instruction:
        body.instruction === undefined
          ? existing.instruction
          : body.instruction,
      displayName:
        body.displayName === undefined
          ? existing.displayName
          : body.displayName,
      description:
        body.description === undefined
          ? existing.description
          : body.description,
      files: files.map((file) => {
        return {
          path: file.path,
          size: new TextEncoder().encode(file.content).length,
        };
      }),
      fileContents: files,
    };
    mockWorkflows[index] = updated;
    return respond(200, updated);
  }),

  mockApi(zeroWorkflowsDetailContract.delete, ({ params, respond }) => {
    const index = mockWorkflows.findIndex((item) => {
      return item.id === params.workflowId;
    });
    if (index === -1) {
      return respond(404, notFound(params.workflowId));
    }
    mockWorkflows = mockWorkflows.filter((item) => {
      return item.id !== params.workflowId;
    });
    return respond(204);
  }),

  mockApi(zeroWorkflowsDetailContract.copy, ({ body, params, respond }) => {
    const source = mockWorkflows.find((item) => {
      return item.id === params.workflowId;
    });
    if (!source) {
      return respond(404, notFound(params.workflowId));
    }
    const copied: ZeroWorkflowDetailResponse = {
      ...source,
      id: crypto.randomUUID(),
      agentId: body.toAgentId,
      visibility: "private",
      requestToPublish: false,
      triggers: [],
    };
    mockWorkflows = [...mockWorkflows, copied];
    return respond(201, summary(copied));
  }),

  mockApi(zeroWorkflowsDetailContract.run, ({ params, respond }) => {
    const workflow = mockWorkflows.find((item) => {
      return item.id === params.workflowId;
    });
    if (!workflow) {
      return respond(404, notFound(params.workflowId));
    }
    return respond(200, {
      chatThreadId: "00000000-0000-4000-a000-000000000fff",
      runId: `run-${workflow.id}`,
    });
  }),

  ...visibilityHandlers(),
];

function visibilityHandlers() {
  const transition = (
    workflowId: string,
    apply: (workflow: ZeroWorkflowDetailResponse) => ZeroWorkflowDetailResponse,
  ): ZeroWorkflowSummary | null => {
    const index = mockWorkflows.findIndex((item) => {
      return item.id === workflowId;
    });
    if (index === -1) {
      return null;
    }
    const updated = apply(mockWorkflows[index]!);
    mockWorkflows[index] = updated;
    return summary(updated);
  };

  return [
    mockApi(
      zeroWorkflowVisibilityContract.requestPublish,
      ({ params, respond }) => {
        const result = transition(params.workflowId, (workflow) => {
          return { ...workflow, requestToPublish: true };
        });
        return result
          ? respond(200, result)
          : respond(404, notFound(params.workflowId));
      },
    ),
    mockApi(
      zeroWorkflowVisibilityContract.cancelPublishRequest,
      ({ params, respond }) => {
        const result = transition(params.workflowId, (workflow) => {
          return { ...workflow, requestToPublish: false };
        });
        return result
          ? respond(200, result)
          : respond(404, notFound(params.workflowId));
      },
    ),
    mockApi(
      zeroWorkflowVisibilityContract.approvePublish,
      ({ params, respond }) => {
        const result = transition(params.workflowId, (workflow) => {
          return { ...workflow, visibility: "public", requestToPublish: false };
        });
        return result
          ? respond(200, result)
          : respond(404, notFound(params.workflowId));
      },
    ),
    mockApi(
      zeroWorkflowVisibilityContract.rejectPublish,
      ({ params, respond }) => {
        const result = transition(params.workflowId, (workflow) => {
          return { ...workflow, requestToPublish: false };
        });
        return result
          ? respond(200, result)
          : respond(404, notFound(params.workflowId));
      },
    ),
    mockApi(zeroWorkflowVisibilityContract.demote, ({ params, respond }) => {
      const result = transition(params.workflowId, (workflow) => {
        return { ...workflow, visibility: "private", requestToPublish: false };
      });
      return result
        ? respond(200, result)
        : respond(404, notFound(params.workflowId));
    }),

    mockApi(zeroWorkflowTriggersContract.list, ({ params, respond }) => {
      const workflow = mockWorkflows.find((item) => {
        return item.id === params.workflowId;
      });
      if (!workflow) {
        return respond(404, notFound(params.workflowId));
      }
      return respond(200, workflow.triggers);
    }),
  ];
}

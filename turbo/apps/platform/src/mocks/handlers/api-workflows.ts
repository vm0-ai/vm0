import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  zeroWorkflowVisibilityContract,
  type ChatThreadWorkflowTrigger,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
  type ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { mockApi } from "../msw-contract.ts";
import {
  getMockWorkflowTriggers,
  setMockWorkflowTriggers,
} from "./automations-store.ts";

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
    ownerUserDisplayName: "Test User",
    ownerUserImageUrl: null,
    canManage: workflow.canManage,
  };
}

function triggerSummary(
  trigger: ChatThreadWorkflowTrigger,
): ZeroWorkflowTriggerSummary {
  if (trigger.kind === "event" && trigger.eventType === "gmail-new-message") {
    return {
      id: trigger.id,
      ownerUserId: "test-user-123",
      enabled: trigger.enabled,
      chatThreadId: trigger.chatThreadId,
      nextRunAt: trigger.nextRunAt,
      lastRunAt: trigger.lastRunAt,
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: { provider: "gmail", event: "new_message" },
      schedule: null,
      scheduleSummary: null,
      unattendedConnectorRefs: ["gmail"],
      unattendedPermissionPolicy: null,
    };
  }
  if (trigger.kind === "event" && trigger.eventType === "gmail-label-applied") {
    return {
      id: trigger.id,
      ownerUserId: "test-user-123",
      enabled: trigger.enabled,
      chatThreadId: trigger.chatThreadId,
      nextRunAt: trigger.nextRunAt,
      lastRunAt: trigger.lastRunAt,
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: {
        provider: "gmail",
        event: "label_applied",
        labelName: "Support",
        resolvedLabelId: "Label_support",
      },
      schedule: null,
      scheduleSummary: null,
      unattendedConnectorRefs: ["gmail"],
      unattendedPermissionPolicy: null,
    };
  }

  return {
    id: trigger.id,
    ownerUserId: "test-user-123",
    enabled: trigger.enabled,
    chatThreadId: trigger.chatThreadId,
    nextRunAt: trigger.nextRunAt,
    lastRunAt: trigger.lastRunAt,
    kind: "schedule",
    schedule: { type: "loop", intervalSeconds: 60 },
    scheduleSummary: trigger.scheduleSummary ?? "Every 60s",
    unattendedConnectorRefs: [],
    unattendedPermissionPolicy: null,
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
    const now = new Date().toISOString();
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
      createdByUserId: "test-user-123",
      updatedByUserId: "test-user-123",
      createdAt: now,
      updatedAt: now,
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
    const now = new Date().toISOString();
    const files = body.files ?? existing.fileContents ?? [];
    const updated: ZeroWorkflowDetailResponse = {
      ...existing,
      updatedByUserId: "test-user-123",
      updatedAt: now,
      name: body.name === undefined ? existing.name : body.name,
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
    const now = new Date().toISOString();
    const copied: ZeroWorkflowDetailResponse = {
      ...source,
      id: crypto.randomUUID(),
      agentId: body.toAgentId,
      visibility: "private",
      requestToPublish: false,
      ownerUserId: "test-user-123",
      createdByUserId: "test-user-123",
      updatedByUserId: "test-user-123",
      createdAt: now,
      updatedAt: now,
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
  ...workflowTriggerHandlers(),
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
    const now = new Date().toISOString();
    mockWorkflows[index] = {
      ...updated,
      updatedByUserId: "test-user-123",
      updatedAt: now,
    };
    return summary(mockWorkflows[index]!);
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
  ];
}

function workflowTriggerHandlers() {
  return [
    mockApi(zeroWorkflowTriggersContract.list, ({ params, respond }) => {
      const workflow = mockWorkflows.find((item) => {
        return item.id === params.workflowId;
      });
      if (!workflow) {
        return respond(404, notFound(params.workflowId));
      }
      return respond(200, workflow.triggers);
    }),

    mockApi(
      zeroWorkflowTriggersContract.listForChatThread,
      ({ params, respond }) => {
        return respond(
          200,
          getMockWorkflowTriggers().filter((trigger) => {
            return trigger.chatThreadId === params.threadId;
          }),
        );
      },
    ),

    mockApi(zeroWorkflowTriggersContract.enable, ({ params, respond }) => {
      const triggers = getMockWorkflowTriggers();
      const trigger = triggers.find((item) => {
        return item.id === params.id;
      });
      if (!trigger) {
        return respond(404, {
          error: {
            message: "Workflow trigger not found",
            code: "NOT_FOUND",
          },
        });
      }
      const updated = { ...trigger, enabled: true };
      setMockWorkflowTriggers(
        triggers.map((item) => {
          return item.id === params.id ? updated : item;
        }),
      );
      return respond(200, triggerSummary(updated));
    }),

    mockApi(zeroWorkflowTriggersContract.disable, ({ params, respond }) => {
      const triggers = getMockWorkflowTriggers();
      const trigger = triggers.find((item) => {
        return item.id === params.id;
      });
      if (!trigger) {
        return respond(404, {
          error: {
            message: "Workflow trigger not found",
            code: "NOT_FOUND",
          },
        });
      }
      const updated = { ...trigger, enabled: false };
      setMockWorkflowTriggers(
        triggers.map((item) => {
          return item.id === params.id ? updated : item;
        }),
      );
      return respond(200, triggerSummary(updated));
    }),
  ];
}

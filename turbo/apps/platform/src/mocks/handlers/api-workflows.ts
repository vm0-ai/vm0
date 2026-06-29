import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  zeroWorkflowVisibilityContract,
  type ChatThreadWorkflowTrigger,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
  type ZeroWorkflowTriggerAutomationEntry,
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
      ownerUserId: trigger.ownerUserId,
      enabled: trigger.enabled,
      chatThreadId: trigger.chatThreadId,
      nextRunAt: trigger.nextRunAt,
      lastRunAt: trigger.lastRunAt,
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: trigger.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (trigger.kind === "event" && trigger.eventType === "gmail-label-applied") {
    return {
      id: trigger.id,
      ownerUserId: trigger.ownerUserId,
      enabled: trigger.enabled,
      chatThreadId: trigger.chatThreadId,
      nextRunAt: trigger.nextRunAt,
      lastRunAt: trigger.lastRunAt,
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: trigger.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
  }
  return {
    id: trigger.id,
    ownerUserId: trigger.ownerUserId,
    enabled: trigger.enabled,
    chatThreadId: trigger.chatThreadId,
    nextRunAt: trigger.nextRunAt,
    lastRunAt: trigger.lastRunAt,
    kind: "schedule",
    schedule: trigger.schedule,
    scheduleSummary: trigger.scheduleSummary,
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
      triggers: source.triggers.map((trigger) => {
        return {
          ...trigger,
          id: crypto.randomUUID(),
          ownerUserId: "test-user-123",
          lastRunAt: null,
        };
      }),
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

  mockApi(zeroWorkflowsDetailContract.chatThread, ({ params, respond }) => {
    const workflow = mockWorkflows.find((item) => {
      return item.id === params.workflowId;
    });
    if (!workflow) {
      return respond(404, notFound(params.workflowId));
    }
    return respond(200, {
      chatThreadId: "00000000-0000-4000-a000-000000000fff",
      prompt: `/${workflow.name}`,
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

function updateDetailTrigger(
  triggerId: string,
  apply: (trigger: ZeroWorkflowTriggerSummary) => ZeroWorkflowTriggerSummary,
): ZeroWorkflowTriggerSummary | null {
  for (const workflow of mockWorkflows) {
    const triggerIndex = workflow.triggers.findIndex((trigger) => {
      return trigger.id === triggerId;
    });
    if (triggerIndex === -1) {
      continue;
    }
    const updated = apply(workflow.triggers[triggerIndex]!);
    workflow.triggers = workflow.triggers.map((trigger) => {
      return trigger.id === triggerId ? updated : trigger;
    });
    return updated;
  }
  return null;
}

function updateChatThreadTrigger(
  triggerId: string,
  apply: (trigger: ChatThreadWorkflowTrigger) => ChatThreadWorkflowTrigger,
): ZeroWorkflowTriggerSummary | null {
  const triggers = getMockWorkflowTriggers();
  const trigger = triggers.find((item) => {
    return item.id === triggerId;
  });
  if (!trigger) {
    return null;
  }
  const updated = apply(trigger);
  setMockWorkflowTriggers(
    triggers.map((item) => {
      return item.id === triggerId ? updated : item;
    }),
  );
  return triggerSummary(updated);
}

function notFoundTrigger() {
  return {
    error: {
      message: "Workflow trigger not found",
      code: "NOT_FOUND",
    },
  };
}

function mockWorkflowTriggerExists(triggerId: string): boolean {
  return (
    getMockWorkflowTriggers().some((trigger) => {
      return trigger.id === triggerId;
    }) ||
    mockWorkflows.some((workflow) => {
      return workflow.triggers.some((trigger) => {
        return trigger.id === triggerId;
      });
    })
  );
}

function workflowTriggerListHandlers() {
  return [
    mockApi(zeroWorkflowTriggersContract.listWorkspace, ({ respond }) => {
      const entries: ZeroWorkflowTriggerAutomationEntry[] =
        mockWorkflows.flatMap((workflow) => {
          return workflow.triggers.map((trigger) => {
            return { workflow: summary(workflow), trigger };
          });
        });
      return respond(200, entries);
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
  ];
}

function setMockWorkflowTriggerEnabled(triggerId: string, enabled: boolean) {
  const triggers = getMockWorkflowTriggers();
  const trigger = triggers.find((item) => {
    return item.id === triggerId;
  });
  if (!trigger) {
    return null;
  }
  const updated = { ...trigger, enabled };
  setMockWorkflowTriggers(
    triggers.map((item) => {
      return item.id === triggerId ? updated : item;
    }),
  );
  return triggerSummary(updated);
}

function workflowTriggerEnabledHandlers() {
  return [
    mockApi(zeroWorkflowTriggersContract.enable, ({ params, respond }) => {
      const updated = setMockWorkflowTriggerEnabled(params.id, true);
      return updated ? respond(200, updated) : respond(404, notFoundTrigger());
    }),
    mockApi(zeroWorkflowTriggersContract.disable, ({ params, respond }) => {
      const updated = setMockWorkflowTriggerEnabled(params.id, false);
      return updated ? respond(200, updated) : respond(404, notFoundTrigger());
    }),
  ];
}

function workflowTriggerRunHandlers() {
  return [
    mockApi(zeroWorkflowTriggersContract.run, ({ params, respond }) => {
      if (!mockWorkflowTriggerExists(params.id)) {
        return respond(404, notFoundTrigger());
      }
      return respond(201, {
        runId: "mock-workflow-trigger-run",
        chatThreadId: "00000000-0000-4000-a000-000000000301",
      });
    }),
  ];
}

function workflowTriggerUpdateHandlers() {
  return [
    mockApi(
      zeroWorkflowTriggersContract.update,
      ({ body, params, respond }) => {
        const updatedChatTrigger = updateChatThreadTrigger(
          params.id,
          (trigger) => {
            if (trigger.kind !== "event" || !("eventConfig" in body)) {
              return trigger;
            }
            return {
              ...trigger,
              eventConfig: body.eventConfig,
            } as ChatThreadWorkflowTrigger;
          },
        );
        if (updatedChatTrigger) {
          return respond(200, updatedChatTrigger);
        }

        const updatedDetailTrigger = updateDetailTrigger(
          params.id,
          (trigger) => {
            if (trigger.kind !== "event" || !("eventConfig" in body)) {
              return trigger;
            }
            return {
              ...trigger,
              eventConfig: body.eventConfig,
            } as ZeroWorkflowTriggerSummary;
          },
        );
        return updatedDetailTrigger
          ? respond(200, updatedDetailTrigger)
          : respond(404, notFoundTrigger());
      },
    ),
  ];
}

function workflowTriggerHandlers() {
  return [
    ...workflowTriggerListHandlers(),
    ...workflowTriggerEnabledHandlers(),
    ...workflowTriggerRunHandlers(),
    ...workflowTriggerUpdateHandlers(),
  ];
}

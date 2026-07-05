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
} from "./workflow-triggers-store.ts";

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
    ownerUserId: workflow.ownerUserId,
    ownerUserDisplayName: "Test User",
    ownerUserImageUrl: null,
    createdAt: workflow.createdAt,
    canManage: workflow.canManage,
    canPublish: workflow.canPublish,
  };
}

function triggerSummaryBase(trigger: ChatThreadWorkflowTrigger) {
  return {
    id: trigger.id,
    ownerUserId: trigger.ownerUserId,
    enabled: trigger.enabled,
    chatThreadId: trigger.chatThreadId,
    nextRunAt: trigger.nextRunAt,
    lastRunAt: trigger.lastRunAt,
  };
}

function triggerSummary(
  trigger: ChatThreadWorkflowTrigger,
): ZeroWorkflowTriggerSummary {
  if (trigger.kind === "event") {
    return {
      ...triggerSummaryBase(trigger),
      kind: "event",
      eventType: trigger.eventType,
      eventConfig: trigger.eventConfig,
      schedule: null,
      scheduleSummary: null,
    } as ZeroWorkflowTriggerSummary;
  }
  return {
    ...triggerSummaryBase(trigger),
    kind: "schedule",
    schedule: trigger.schedule,
    scheduleSummary: trigger.scheduleSummary,
  };
}

function publicWorkflowTrigger(
  trigger: ZeroWorkflowTriggerSummary,
): ZeroWorkflowTriggerSummary {
  if (trigger.kind !== "event" || trigger.eventType !== "webhook-received") {
    return trigger;
  }
  const {
    webhookUrl: _webhookUrl,
    webhookSecret: _webhookSecret,
    ...rest
  } = trigger;
  return rest;
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
      ownerUserId: "test-user-123",
      canManage: true,
      canPublish: true,
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
      ownerUserId: "test-user-123",
      canPublish: true,
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
      prompt: `help me refine the workflow /${workflow.name}`,
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
    mockApi(zeroWorkflowVisibilityContract.publish, ({ params, respond }) => {
      const result = transition(params.workflowId, (workflow) => {
        return { ...workflow, visibility: "public" };
      });
      return result
        ? respond(200, result)
        : respond(404, notFound(params.workflowId));
    }),
    mockApi(zeroWorkflowVisibilityContract.demote, ({ params, respond }) => {
      const result = transition(params.workflowId, (workflow) => {
        return { ...workflow, visibility: "private" };
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

function mockScheduleSummary(
  schedule: Extract<
    ZeroWorkflowTriggerSummary,
    { kind: "schedule" }
  >["schedule"],
): string {
  if (schedule.type === "cron") {
    return `${schedule.cronExpression} (${schedule.timezone})`;
  }
  if (schedule.type === "once") {
    return `Once at ${schedule.atTime}`;
  }
  return `Every ${schedule.intervalSeconds}s`;
}

function workflowTriggerListHandlers() {
  return [
    mockApi(zeroWorkflowTriggersContract.listWorkspace, ({ respond }) => {
      const entries: ZeroWorkflowTriggerAutomationEntry[] =
        mockWorkflows.flatMap((workflow) => {
          return workflow.triggers.map((trigger) => {
            return {
              workflow: summary(workflow),
              trigger: publicWorkflowTrigger(trigger),
            };
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
      return respond(200, workflow.triggers.map(publicWorkflowTrigger));
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

function workflowTriggerCreateHandlers() {
  return [
    mockApi(
      zeroWorkflowTriggersContract.create,
      ({ body, params, respond }) => {
        const workflow = mockWorkflows.find((item) => {
          return item.id === params.workflowId;
        });
        if (!workflow) {
          return respond(404, notFound(params.workflowId));
        }

        const base = {
          id: crypto.randomUUID(),
          ownerUserId: "test-user-123",
          enabled: body.enabled ?? true,
          chatThreadId: "00000000-0000-4000-a000-000000000301",
          nextRunAt: null,
          lastRunAt: null,
        };
        let trigger: ZeroWorkflowTriggerSummary;
        if ("schedule" in body) {
          trigger = {
            ...base,
            kind: "schedule",
            schedule: body.schedule,
            scheduleSummary: mockScheduleSummary(body.schedule),
          };
        } else if (body.eventType === "webhook-received") {
          trigger = {
            ...base,
            kind: "event",
            eventType: "webhook-received",
            eventConfig: body.eventConfig ?? {
              provider: "webhook",
              event: "received",
              auth: { mode: "hmac-sha256" },
            },
            schedule: null,
            scheduleSummary: null,
            webhookUrl:
              "http://localhost:3000/api/webhooks/workflow-triggers/mock",
            secretLastFour: "mock",
            lastReceivedAt: null,
            webhookSecret: "mock-webhook-secret",
          };
        } else if (body.eventType === "gmail-new-message") {
          trigger = {
            ...base,
            kind: "event",
            eventType: "gmail-new-message",
            eventConfig: body.eventConfig,
            schedule: null,
            scheduleSummary: null,
          };
        } else if (body.eventType === "gmail-label-applied") {
          trigger = {
            ...base,
            kind: "event",
            eventType: "gmail-label-applied",
            eventConfig: body.eventConfig,
            schedule: null,
            scheduleSummary: null,
          };
        } else if (body.eventType === "github-label-applied") {
          trigger = {
            ...base,
            kind: "event",
            eventType: "github-label-applied",
            eventConfig: body.eventConfig,
            schedule: null,
            scheduleSummary: null,
          };
        } else if (body.eventType === "google-calendar-event-created") {
          trigger = {
            ...base,
            kind: "event",
            eventType: "google-calendar-event-created",
            eventConfig: body.eventConfig,
            schedule: null,
            scheduleSummary: null,
          };
        } else if (body.eventType === "google-calendar-event-updated") {
          trigger = {
            ...base,
            kind: "event",
            eventType: "google-calendar-event-updated",
            eventConfig: body.eventConfig,
            schedule: null,
            scheduleSummary: null,
          };
        } else if (body.eventType === "google-calendar-event-cancelled") {
          trigger = {
            ...base,
            kind: "event",
            eventType: "google-calendar-event-cancelled",
            eventConfig: body.eventConfig,
            schedule: null,
            scheduleSummary: null,
          };
        } else {
          trigger = {
            ...base,
            kind: "event",
            eventType: "google-meet-transcript-generated",
            eventConfig: body.eventConfig,
            schedule: null,
            scheduleSummary: null,
          };
        }
        workflow.triggers = [...workflow.triggers, trigger];
        return respond(201, trigger);
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
    mockApi(
      zeroWorkflowTriggersContract.revealWebhookSecret,
      ({ params, respond }) => {
        for (const workflow of mockWorkflows) {
          const detailTrigger = workflow.triggers.find((item) => {
            return item.id === params.id;
          });
          if (
            detailTrigger &&
            detailTrigger.kind === "event" &&
            detailTrigger.eventType === "webhook-received"
          ) {
            return respond(200, {
              webhookUrl:
                detailTrigger.webhookUrl ??
                "http://localhost:3000/api/webhooks/workflow-triggers/mock",
              webhookSecret:
                detailTrigger.webhookSecret ?? "mock-webhook-secret",
            });
          }
        }

        return respond(404, notFoundTrigger());
      },
    ),
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
    ...workflowTriggerCreateHandlers(),
    ...workflowTriggerEnabledHandlers(),
    ...workflowTriggerRunHandlers(),
    ...workflowTriggerUpdateHandlers(),
  ];
}

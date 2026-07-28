import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowAutomationsContract,
  zeroWorkflowVisibilityContract,
  type ChatThreadWorkflowAutomation,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
  type ZeroWorkflowAutomationsListEntry,
  type ZeroWorkflowAutomationCreateRequest,
  type ZeroWorkflowAutomationSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";

import { mockApi } from "../msw-contract.ts";
import {
  getMockWorkflowAutomations,
  setMockWorkflowAutomations,
} from "./workflow-automations-store.ts";

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

function automationSummaryBase(automation: ChatThreadWorkflowAutomation) {
  return {
    id: automation.id,
    ownerUserId: automation.ownerUserId,
    enabled: automation.enabled,
    chatThreadId: automation.chatThreadId,
    nextRunAt: automation.nextRunAt,
    lastRunAt: automation.lastRunAt,
  };
}

function automationSummary(
  automation: ChatThreadWorkflowAutomation,
): ZeroWorkflowAutomationSummary {
  if (automation.kind === "event") {
    return {
      ...automationSummaryBase(automation),
      kind: "event",
      eventType: automation.eventType,
      eventConfig: automation.eventConfig,
      schedule: null,
      scheduleSummary: null,
    } as ZeroWorkflowAutomationSummary;
  }
  return {
    ...automationSummaryBase(automation),
    kind: "schedule",
    schedule: automation.schedule,
    scheduleSummary: automation.scheduleSummary,
  };
}

function publicWorkflowAutomation(
  automation: ZeroWorkflowAutomationSummary,
): ZeroWorkflowAutomationSummary {
  if (
    automation.kind !== "event" ||
    automation.eventType !== "webhook-received"
  ) {
    return automation;
  }
  const {
    webhookUrl: _webhookUrl,
    webhookSecret: _webhookSecret,
    ...rest
  } = automation;
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
      automations: [],
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

  mockApi(
    zeroWorkflowsDetailContract.connectorReadiness,
    ({ params, respond }) => {
      const workflow = mockWorkflows.find((item) => {
        return item.id === params.workflowId;
      });
      if (!workflow) {
        return respond(404, notFound(params.workflowId));
      }
      return respond(200, { connectors: [] });
    },
  ),

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
      automations: source.automations.map((automation) => {
        return {
          ...automation,
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
  ...workflowAutomationHandlers(),
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

function updateDetailAutomation(
  automationId: string,
  apply: (
    automation: ZeroWorkflowAutomationSummary,
  ) => ZeroWorkflowAutomationSummary,
): ZeroWorkflowAutomationSummary | null {
  for (const workflow of mockWorkflows) {
    const automationIndex = workflow.automations.findIndex((automation) => {
      return automation.id === automationId;
    });
    if (automationIndex === -1) {
      continue;
    }
    const updated = apply(workflow.automations[automationIndex]!);
    workflow.automations = workflow.automations.map((automation) => {
      return automation.id === automationId ? updated : automation;
    });
    return updated;
  }
  return null;
}

function updateChatThreadAutomation(
  automationId: string,
  apply: (
    automation: ChatThreadWorkflowAutomation,
  ) => ChatThreadWorkflowAutomation,
): ZeroWorkflowAutomationSummary | null {
  const automations = getMockWorkflowAutomations();
  const automation = automations.find((item) => {
    return item.id === automationId;
  });
  if (!automation) {
    return null;
  }
  const updated = apply(automation);
  setMockWorkflowAutomations(
    automations.map((item) => {
      return item.id === automationId ? updated : item;
    }),
  );
  return automationSummary(updated);
}

function notFoundAutomation() {
  return {
    error: {
      message: "Workflow automation not found",
      code: "NOT_FOUND",
    },
  };
}

function mockWorkflowAutomationExists(automationId: string): boolean {
  return (
    getMockWorkflowAutomations().some((automation) => {
      return automation.id === automationId;
    }) ||
    mockWorkflows.some((workflow) => {
      return workflow.automations.some((automation) => {
        return automation.id === automationId;
      });
    })
  );
}

function mockScheduleSummary(
  schedule: Extract<
    ZeroWorkflowAutomationSummary,
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

function workflowAutomationListHandlers() {
  return [
    mockApi(zeroWorkflowAutomationsContract.listWorkspace, ({ respond }) => {
      const entries: ZeroWorkflowAutomationsListEntry[] = mockWorkflows.flatMap(
        (workflow) => {
          return workflow.automations.map((automation) => {
            return {
              workflow: summary(workflow),
              automation: publicWorkflowAutomation(automation),
            };
          });
        },
      );
      // The ts-rest mock responder retains the legacy spread source's
      // response type even though the canonical contract overrides status 200.
      return respond(200, entries as never);
    }),

    mockApi(zeroWorkflowAutomationsContract.list, ({ params, respond }) => {
      const workflow = mockWorkflows.find((item) => {
        return item.id === params.workflowId;
      });
      if (!workflow) {
        return respond(404, notFound(params.workflowId));
      }
      return respond(200, workflow.automations.map(publicWorkflowAutomation));
    }),

    mockApi(
      zeroWorkflowAutomationsContract.listForChatThread,
      ({ params, respond }) => {
        return respond(
          200,
          getMockWorkflowAutomations().filter((automation) => {
            return automation.chatThreadId === params.threadId;
          }),
        );
      },
    ),
  ];
}

type WorkflowAutomationCreateBase = {
  readonly id: string;
  readonly ownerUserId: string;
  readonly enabled: boolean;
  readonly chatThreadId: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
};

function createNotionChildPageAutomationSummary(
  base: WorkflowAutomationCreateBase,
  parentPageUrl: string,
): ZeroWorkflowAutomationSummary {
  return {
    ...base,
    kind: "event",
    eventType: "notion-child-page-created",
    eventConfig: {
      provider: "notion",
      event: "child_page_created",
      connectorId: "b0000000-0000-4000-a000-000000000001",
      parentPage: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "Roadmap",
        url: parentPageUrl,
        rawUrl: parentPageUrl,
      },
    },
    schedule: null,
    scheduleSummary: null,
  };
}

function createNotionDatabaseItemAutomationSummary(
  base: WorkflowAutomationCreateBase,
  databaseUrl: string,
): ZeroWorkflowAutomationSummary {
  return {
    ...base,
    kind: "event",
    eventType: "notion-database-item-created",
    eventConfig: {
      provider: "notion",
      event: "database_item_created",
      connectorId: "b0000000-0000-4000-a000-000000000001",
      dataSource: {
        id: "22222222-2222-4222-8222-222222222222",
        title: "Bug Bash",
        url: databaseUrl,
        rawUrl: databaseUrl,
      },
    },
    schedule: null,
    scheduleSummary: null,
  };
}

function createNotionPageContentUpdatedAutomationSummary(
  base: WorkflowAutomationCreateBase,
  args: { readonly pageUrl?: string; readonly databaseUrl?: string },
): ZeroWorkflowAutomationSummary {
  return {
    ...base,
    kind: "event",
    eventType: "notion-page-content-updated",
    eventConfig: {
      provider: "notion",
      event: "page_content_updated",
      connectorId: "b0000000-0000-4000-a000-000000000001",
      scope: args.pageUrl
        ? {
            type: "page",
            page: {
              id: "33333333-3333-4333-8333-333333333333",
              title: "Release plan",
              url: args.pageUrl,
              rawUrl: args.pageUrl,
            },
          }
        : {
            type: "data_source",
            dataSource: {
              id: "22222222-2222-4222-8222-222222222222",
              title: "Bug Bash",
              url: args.databaseUrl ?? "https://www.notion.so/database",
              rawUrl: args.databaseUrl,
            },
          },
    },
    schedule: null,
    scheduleSummary: null,
  };
}

function createWorkflowAutomationSummaryForRequest(
  base: WorkflowAutomationCreateBase,
  body: ZeroWorkflowAutomationCreateRequest,
): ZeroWorkflowAutomationSummary {
  if ("schedule" in body) {
    return {
      ...base,
      kind: "schedule",
      schedule: body.schedule,
      scheduleSummary: mockScheduleSummary(body.schedule),
    };
  }
  if (body.eventType === "webhook-received") {
    return {
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
        "http://localhost:3000/api/webhooks/workflow-automations/mock",
      secretLastFour: "mock",
      lastReceivedAt: null,
      webhookSecret: "mock-webhook-secret",
    };
  }
  if (body.eventType === "gmail-new-message") {
    return {
      ...base,
      kind: "event",
      eventType: "gmail-new-message",
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (body.eventType === "gmail-label-applied") {
    return {
      ...base,
      kind: "event",
      eventType: "gmail-label-applied",
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (body.eventType === "github-label-applied") {
    return {
      ...base,
      kind: "event",
      eventType: "github-label-applied",
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
  }
  if (
    body.eventType === "github-workflow-run-completed" ||
    body.eventType === "github-workflow-job-completed" ||
    body.eventType === "github-pull-request-review-submitted" ||
    body.eventType === "github-deployment-status-created" ||
    body.eventType === "github-issue-comment-created"
  ) {
    return {
      ...base,
      kind: "event",
      eventType: body.eventType,
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    } as ZeroWorkflowAutomationSummary;
  }
  if (
    body.eventType === "google-calendar-event-created" ||
    body.eventType === "google-calendar-event-updated" ||
    body.eventType === "google-calendar-event-cancelled" ||
    body.eventType === "google-meet-transcript-generated"
  ) {
    return {
      ...base,
      kind: "event",
      eventType: body.eventType,
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    } as ZeroWorkflowAutomationSummary;
  }
  if (body.eventType === "notion-child-page-created") {
    return createNotionChildPageAutomationSummary(
      base,
      body.eventConfig.parentPageUrl,
    );
  }
  if (body.eventType === "notion-database-item-created") {
    return createNotionDatabaseItemAutomationSummary(
      base,
      body.eventConfig.databaseUrl,
    );
  }
  if (body.eventType === "notion-page-content-updated") {
    return createNotionPageContentUpdatedAutomationSummary(base, {
      pageUrl: body.eventConfig.pageUrl,
      databaseUrl: body.eventConfig.databaseUrl,
    });
  }
  if (body.eventType === "strapi-entry-published") {
    return {
      ...base,
      kind: "event",
      eventType: "strapi-entry-published",
      eventConfig: body.eventConfig,
      schedule: null,
      scheduleSummary: null,
    };
  }
  const exhaustive: never = body;
  return exhaustive;
}

function workflowAutomationCreateHandlers() {
  return [
    mockApi(
      zeroWorkflowAutomationsContract.create,
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
        const automation = createWorkflowAutomationSummaryForRequest(
          base,
          body,
        );
        workflow.automations = [...workflow.automations, automation];
        return respond(201, automation);
      },
    ),
  ];
}

function setMockWorkflowAutomationEnabled(
  automationId: string,
  enabled: boolean,
) {
  const automations = getMockWorkflowAutomations();
  const automation = automations.find((item) => {
    return item.id === automationId;
  });
  if (!automation) {
    return null;
  }
  const updated = { ...automation, enabled };
  setMockWorkflowAutomations(
    automations.map((item) => {
      return item.id === automationId ? updated : item;
    }),
  );
  return automationSummary(updated);
}

function workflowAutomationEnabledHandlers() {
  return [
    mockApi(zeroWorkflowAutomationsContract.enable, ({ params, respond }) => {
      const updated = setMockWorkflowAutomationEnabled(params.id, true);
      return updated
        ? respond(200, updated)
        : respond(404, notFoundAutomation());
    }),
    mockApi(zeroWorkflowAutomationsContract.disable, ({ params, respond }) => {
      const updated = setMockWorkflowAutomationEnabled(params.id, false);
      return updated
        ? respond(200, updated)
        : respond(404, notFoundAutomation());
    }),
  ];
}

function workflowAutomationRunHandlers() {
  return [
    mockApi(
      zeroWorkflowAutomationsContract.revealWebhookSecret,
      ({ params, respond }) => {
        for (const workflow of mockWorkflows) {
          const detailAutomation = workflow.automations.find((item) => {
            return item.id === params.id;
          });
          if (
            detailAutomation &&
            detailAutomation.kind === "event" &&
            detailAutomation.eventType === "webhook-received"
          ) {
            return respond(200, {
              webhookUrl:
                detailAutomation.webhookUrl ??
                "http://localhost:3000/api/webhooks/workflow-automations/mock",
              webhookSecret:
                detailAutomation.webhookSecret ?? "mock-webhook-secret",
            });
          }
        }

        return respond(404, notFoundAutomation());
      },
    ),
    mockApi(zeroWorkflowAutomationsContract.run, ({ params, respond }) => {
      if (!mockWorkflowAutomationExists(params.id)) {
        return respond(404, notFoundAutomation());
      }
      return respond(201, {
        runId: "mock-workflow-automation-run",
        chatThreadId: "00000000-0000-4000-a000-000000000301",
      });
    }),
  ];
}

function workflowAutomationUpdateHandlers() {
  return [
    mockApi(
      zeroWorkflowAutomationsContract.update,
      ({ body, params, respond }) => {
        const updatedChatAutomation = updateChatThreadAutomation(
          params.id,
          (automation) => {
            if (automation.kind !== "event" || !("eventConfig" in body)) {
              return automation;
            }
            return {
              ...automation,
              eventConfig: body.eventConfig,
            } as ChatThreadWorkflowAutomation;
          },
        );
        if (updatedChatAutomation) {
          return respond(200, updatedChatAutomation);
        }

        const updatedDetailAutomation = updateDetailAutomation(
          params.id,
          (automation) => {
            if (automation.kind !== "event" || !("eventConfig" in body)) {
              return automation;
            }
            return {
              ...automation,
              eventConfig: body.eventConfig,
            } as ZeroWorkflowAutomationSummary;
          },
        );
        return updatedDetailAutomation
          ? respond(200, updatedDetailAutomation)
          : respond(404, notFoundAutomation());
      },
    ),
  ];
}

function workflowAutomationHandlers() {
  return [
    ...workflowAutomationListHandlers(),
    ...workflowAutomationCreateHandlers(),
    ...workflowAutomationEnabledHandlers(),
    ...workflowAutomationRunHandlers(),
    ...workflowAutomationUpdateHandlers(),
  ];
}

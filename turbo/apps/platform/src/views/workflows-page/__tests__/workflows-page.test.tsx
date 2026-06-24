import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  zeroWorkflowTriggersContract,
  type ZeroWorkflowTriggerCreateRequest,
  type ZeroWorkflowTriggerUpdateRequest,
  type ZeroWorkflowUpdateRequest,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
  type ZeroWorkflowTriggerSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const CURRENT_USER_ID = "test-user-123";
const AGENT_ID = "c0000000-0000-4000-a000-000000000101";
const SALES_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000201";
const OPS_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000202";
const GMAIL_TRIGGER_ID = "workflow-trigger-gmail-new-message";

type WorkflowScheduleTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "schedule" }
>;
type WorkflowGmailNewMessageTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "event" }
>;

function workflowTriggers(): ZeroWorkflowTriggerSummary[] {
  return [weekdayWorkflowTrigger()];
}

function weekdayWorkflowTrigger(): WorkflowScheduleTriggerSummary {
  return {
    id: "workflow-trigger-weekday-brief",
    kind: "schedule",
    schedule: {
      type: "cron",
      cronExpression: "0 9 * * 1-5",
      timezone: "UTC",
    },
    scheduleSummary: "Weekdays at 9:00 AM",
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_weekday_brief",
    nextRunAt: "2026-06-19T01:00:00.000Z",
    lastRunAt: "2026-06-18T01:00:00.000Z",
  };
}

function gmailWorkflowTrigger(): WorkflowGmailNewMessageTriggerSummary {
  return {
    id: GMAIL_TRIGGER_ID,
    kind: "event",
    eventType: "gmail-new-message",
    eventConfig: {
      provider: "gmail",
      event: "new_message",
      match: {
        from: { contains: "@acme.com" },
        subject: { doesNotContain: "newsletter" },
      },
    },
    schedule: null,
    scheduleSummary: null,
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_gmail_new_message",
    nextRunAt: null,
    lastRunAt: null,
  };
}

function salesResearch(): ZeroWorkflowDetailResponse {
  return {
    id: SALES_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "sales-research",
    displayName: "Sales Research",
    description: "Collects account context before outreach.",
    visibility: "public",
    requestToPublish: false,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    instruction: "Gather CRM context before outreach.",
    files: [
      { path: "examples/prompt.md", size: 1536 },
      { path: "config/settings.json", size: 32 },
    ],
    fileContents: [
      {
        path: "examples/prompt.md",
        content: "# Prompt example\n\nAsk for market segment and urgency.\n",
      },
      {
        path: "config/settings.json",
        content: '{ "risk": "low", "tone": "direct" }',
      },
    ],
    triggers: workflowTriggers(),
  };
}

function opsPlaybook(): ZeroWorkflowDetailResponse {
  return {
    id: OPS_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "ops-playbook",
    displayName: "Ops Playbook",
    description: null,
    visibility: "private",
    requestToPublish: false,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    instruction: null,
    files: [],
    fileContents: [],
    triggers: [],
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

function applyWorkflowUpdate(
  workflow: ZeroWorkflowDetailResponse,
  body: ZeroWorkflowUpdateRequest,
): ZeroWorkflowDetailResponse {
  return {
    ...workflow,
    ...(body.instruction !== undefined
      ? { instruction: body.instruction }
      : {}),
    ...(body.displayName !== undefined
      ? { displayName: body.displayName }
      : {}),
    ...(body.description !== undefined
      ? { description: body.description }
      : {}),
    ...(body.files !== undefined
      ? {
          files: body.files.map((file) => {
            return { path: file.path, size: file.content.length };
          }),
          fileContents: body.files,
        }
      : {}),
  };
}

function mockWorkflowApis(
  workflows: ZeroWorkflowDetailResponse[],
  onUpdate?: (body: ZeroWorkflowUpdateRequest) => void,
): void {
  context.mocks.api(
    zeroWorkflowsCollectionContract.list,
    ({ query, respond }) => {
      const visible = query.agentId
        ? workflows.filter((workflow) => {
            return workflow.agentId === query.agentId;
          })
        : workflows;
      return respond(200, visible.map(summary));
    },
  );
  context.mocks.api(zeroWorkflowsDetailContract.get, ({ params, respond }) => {
    const detail = workflows.find((workflow) => {
      return workflow.id === params.workflowId;
    });
    if (!detail) {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "missing" },
      });
    }
    return respond(200, detail);
  });
  context.mocks.api(
    zeroWorkflowsDetailContract.update,
    ({ params, body, respond }) => {
      const index = workflows.findIndex((workflow) => {
        return workflow.id === params.workflowId;
      });
      if (index === -1) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "missing" },
        });
      }
      onUpdate?.(body);
      const workflow = workflows[index];
      workflows[index] = applyWorkflowUpdate(workflow, body);
      return respond(200, workflows[index]);
    },
  );
}

function mockCreateWorkflowTrigger(
  onCreate: (body: ZeroWorkflowTriggerCreateRequest) => void,
): void {
  context.mocks.api(
    zeroWorkflowTriggersContract.create,
    ({ body, respond }) => {
      onCreate(body);
      if (body.kind !== "event") {
        return respond(201, weekdayWorkflowTrigger());
      }
      return respond(201, {
        ...gmailWorkflowTrigger(),
        eventConfig: body.eventConfig,
      });
    },
  );
}

function mockUpdateWorkflowTrigger(
  onUpdate: (triggerId: string, body: ZeroWorkflowTriggerUpdateRequest) => void,
): void {
  context.mocks.api(
    zeroWorkflowTriggersContract.update,
    ({ params, body, respond }) => {
      onUpdate(params.id, body);
      if ("eventConfig" in body) {
        return respond(200, {
          ...gmailWorkflowTrigger(),
          id: params.id,
          eventConfig: body.eventConfig,
        });
      }
      return respond(200, {
        ...weekdayWorkflowTrigger(),
        id: params.id,
        schedule: body.schedule,
      });
    },
  );
}

describe("workflows index page", () => {
  it("shows every visible workflow with its agent and links into the detail page", async () => {
    mockWorkflowApis([salesResearch(), opsPlaybook()]);

    detachedSetupPage({ context, path: "/workflows" });

    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });
    expect(screen.getByText("Ops Playbook")).toBeInTheDocument();
    expect(screen.getAllByText("Research Bot").length).toBeGreaterThan(0);
    expect(screen.getByText("private")).toBeInTheDocument();

    const searchInput = screen.getByLabelText("Search workflows");
    await fill(searchInput, "ops");
    await waitFor(() => {
      expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Ops Playbook")).toBeInTheDocument();

    const opsLink = screen.getByText("Ops Playbook").closest("a");
    expect(opsLink).toHaveAttribute(
      "href",
      `/agents/${AGENT_ID}/workflows/${OPS_WORKFLOW_ID}`,
    );
  });
});

describe("workflow detail page", () => {
  it("renders the instruction, files, and triggers", async () => {
    mockWorkflowApis([salesResearch()]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${SALES_WORKFLOW_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Instruction")).toHaveValue(
      "Gather CRM context before outreach.",
    );
    expect(screen.getByText("Triggers")).toBeInTheDocument();
    expect(screen.getByText("Weekdays at 9:00 AM")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Open thread")).toBeInTheDocument();

    click(screen.getByLabelText("Open config/settings.json"));
    await waitFor(() => {
      expect(
        screen.getByText('{ "risk": "low", "tone": "direct" }'),
      ).toBeInTheDocument();
    });
  });

  it("renders Gmail new message trigger match summaries", async () => {
    const workflow = {
      ...salesResearch(),
      triggers: [...workflowTriggers(), gmailWorkflowTrigger()],
    };
    mockWorkflowApis([workflow]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${SALES_WORKFLOW_ID}`,
    });

    await waitFor(() => {
      expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(
        0,
      );
    });
    expect(screen.getByText(/from contains "@acme.com"/)).toBeInTheDocument();
    expect(
      screen.getByText(/subject does not contain "newsletter"/),
    ).toBeInTheDocument();
  });

  it("creates a Gmail new message trigger with text match rules", async () => {
    const createBodies: ZeroWorkflowTriggerCreateRequest[] = [];
    mockWorkflowApis([salesResearch()]);
    mockCreateWorkflowTrigger((body) => {
      createBodies.push(body);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${SALES_WORKFLOW_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });
    const createTriggerForm = screen.getByRole("form", {
      name: "Create Gmail new message trigger",
    });
    await fill(
      within(createTriggerForm).getByLabelText("From contains"),
      "@acme.com",
    );
    await fill(
      within(createTriggerForm).getByLabelText("Subject does not contain"),
      "newsletter",
    );
    fireEvent.submit(createTriggerForm);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            from: { contains: "@acme.com" },
            subject: { doesNotContain: "newsletter" },
          },
        },
      });
    });
  });

  it("updates a Gmail new message trigger with text match rules", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    const workflow = {
      ...salesResearch(),
      triggers: [
        {
          ...gmailWorkflowTrigger(),
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: {
              from: { containsAny: ["@vip.example"] },
              subject: { doesNotContain: "newsletter" },
              hasAttachment: true,
            },
          },
        } satisfies WorkflowGmailNewMessageTriggerSummary,
      ],
    };
    mockWorkflowApis([workflow]);
    mockUpdateWorkflowTrigger((triggerId, body) => {
      updateBodies.push({ triggerId, body });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${SALES_WORKFLOW_ID}`,
    });

    await waitFor(() => {
      expect(screen.getAllByText("Gmail new message").length).toBeGreaterThan(
        0,
      );
    });
    click(screen.getByText("Edit match"));

    const updateTriggerForm = screen.getByRole("form", {
      name: "Update Gmail new message trigger",
    });
    await fill(
      within(updateTriggerForm).getByLabelText("From contains"),
      "@acme.com",
    );
    await fill(
      within(updateTriggerForm).getByLabelText("Body contains"),
      "invoice",
    );
    fireEvent.submit(updateTriggerForm);

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: GMAIL_TRIGGER_ID,
        body: {
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: {
              from: {
                contains: "@acme.com",
                containsAny: ["@vip.example"],
              },
              subject: { doesNotContain: "newsletter" },
              body: { contains: "invoice" },
              hasAttachment: true,
            },
          },
        },
      });
    });
  });

  it("warns when the workflow is shadowed by the runtime slash priority", async () => {
    const workflow = {
      ...salesResearch(),
      shadowedBy: {
        id: OPS_WORKFLOW_ID,
        name: "sales-research",
        displayName: "Private Sales Research",
      },
    };
    mockWorkflowApis([workflow]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${SALES_WORKFLOW_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText(/currently resolves to/i)).toBeInTheDocument();
    });
    expect(screen.getByText("Private Sales Research")).toBeInTheDocument();
  });

  it("deletes the selected supplementary file through the workflow update endpoint", async () => {
    const updateBodies: ZeroWorkflowUpdateRequest[] = [];
    mockWorkflowApis([salesResearch()], (body) => {
      updateBodies.push(body);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${SALES_WORKFLOW_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });
    click(screen.getByLabelText("Open config/settings.json"));
    click(screen.getByLabelText("Delete config/settings.json"));

    await waitFor(() => {
      expect(updateBodies.at(-1)?.files).toStrictEqual([
        {
          path: "examples/prompt.md",
          content: "# Prompt example\n\nAsk for market segment and urgency.\n",
        },
      ]);
    });
  });

  it("uploads supplementary files through the workflow update endpoint", async () => {
    const updateBodies: ZeroWorkflowUpdateRequest[] = [];
    mockWorkflowApis([salesResearch()], (body) => {
      updateBodies.push(body);
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${SALES_WORKFLOW_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });

    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) {
      throw new Error("Expected upload input");
    }
    fireEvent.change(input, {
      target: {
        files: [new File(["new notes"], "notes.md", { type: "text/markdown" })],
      },
    });

    await waitFor(() => {
      expect(updateBodies.at(-1)?.files).toContainEqual({
        path: "notes.md",
        content: "new notes",
      });
    });
    expect(updateBodies.at(-1)?.files).toContainEqual({
      path: "config/settings.json",
      content: '{ "risk": "low", "tone": "direct" }',
    });
  });
});

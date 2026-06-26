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
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { search } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const CURRENT_USER_ID = "test-user-123";
const AGENT_ID = "c0000000-0000-4000-a000-000000000101";
const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000102";
const SALES_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000201";
const OPS_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000202";
const OTHER_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000203";
const PENDING_WORKFLOW_ID = "d0000000-0000-4000-a000-000000000204";
const GMAIL_TRIGGER_ID = "workflow-trigger-gmail-new-message";
const GMAIL_LABEL_TRIGGER_ID = "workflow-trigger-gmail-label-applied";

type WorkflowScheduleTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { kind: "schedule" }
>;
type WorkflowGmailNewMessageTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { eventType: "gmail-new-message" }
>;
type WorkflowGmailLabelAppliedTriggerSummary = Extract<
  ZeroWorkflowTriggerSummary,
  { eventType: "gmail-label-applied" }
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
    unattendedConnectorRefs: [],
    unattendedPermissionPolicy: null,
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
    unattendedConnectorRefs: ["gmail"],
    unattendedPermissionPolicy: null,
  };
}

function gmailLabelWorkflowTrigger(): WorkflowGmailLabelAppliedTriggerSummary {
  return {
    id: GMAIL_LABEL_TRIGGER_ID,
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
    ownerUserId: CURRENT_USER_ID,
    enabled: true,
    chatThreadId: "thread_gmail_label_applied",
    nextRunAt: null,
    lastRunAt: null,
    unattendedConnectorRefs: ["gmail"],
    unattendedPermissionPolicy: null,
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

function pendingReviewWorkflow(): ZeroWorkflowDetailResponse {
  return {
    id: PENDING_WORKFLOW_ID,
    agentId: AGENT_ID,
    agentName: "research-bot",
    agentDisplayName: "Research Bot",
    name: "launch-checklist",
    displayName: "Launch Checklist",
    description: "Prepares release approvals.",
    visibility: "private",
    requestToPublish: true,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    instruction: null,
    files: [],
    fileContents: [],
    triggers: [],
  };
}

function otherAgentWorkflow(): ZeroWorkflowDetailResponse {
  return {
    id: OTHER_WORKFLOW_ID,
    agentId: OTHER_AGENT_ID,
    agentName: "support-bot",
    agentDisplayName: "Support Bot",
    name: "support-intake",
    displayName: "Support Intake",
    description: "Sorts incoming support requests.",
    visibility: "public",
    requestToPublish: false,
    ownerUserId: CURRENT_USER_ID,
    canManage: true,
    instruction: null,
    files: [],
    fileContents: [],
    triggers: [],
  };
}

function agent(id: string, displayName: string): TeamComposeItem {
  return {
    id,
    ownerId: CURRENT_USER_ID,
    displayName,
    description: "Finds and summarizes information",
    sound: null,
    avatarUrl: null,
    visibility: "public",
    headVersionId: "version_2",
    updatedAt: "2026-06-01T00:00:00Z",
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

function mockAgentPageApis(): void {
  context.mocks.data.team([
    agent(AGENT_ID, "Research Bot"),
    agent(OTHER_AGENT_ID, "Support Bot"),
  ]);
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const displayName =
      params.id === OTHER_AGENT_ID ? "Support Bot" : "Research Bot";
    return respond(200, {
      agentId: params.id,
      ownerId: CURRENT_USER_ID,
      description: "Finds and summarizes information",
      displayName,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    });
  });
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
      if (body.eventType === "gmail-label-applied") {
        return respond(201, {
          ...gmailLabelWorkflowTrigger(),
          eventConfig: body.eventConfig,
        });
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
        if (body.eventConfig.event === "label_applied") {
          return respond(200, {
            ...gmailLabelWorkflowTrigger(),
            id: params.id,
            eventConfig: body.eventConfig,
          });
        }
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

type RoleTextMatch = RegExp | string;

function textFor(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function valueMatchesText(value: string, text: RoleTextMatch): boolean {
  return typeof text === "string" ? value === text : text.test(value);
}

function matchesText(element: Element, text: RoleTextMatch): boolean {
  const label = element.getAttribute("aria-label") ?? "";
  return [textFor(element), label].some((value) => {
    return value.length > 0 && valueMatchesText(value, text);
  });
}

function matchLabel(text: RoleTextMatch): string {
  return typeof text === "string" ? text : text.toString();
}

function buttonByText(
  text: RoleTextMatch,
  container: ParentNode = document.body,
): HTMLElement {
  const buttons = queryAllByRoleFast("button", container);
  const button = buttons.find((candidate) => {
    return matchesText(candidate, text);
  });
  if (!button) {
    throw new Error(`${matchLabel(text)} button not found`);
  }
  return button;
}

function queryButtonByText(
  text: RoleTextMatch,
  container: ParentNode = document.body,
): HTMLElement | null {
  return (
    queryAllByRoleFast("button", container).find((candidate) => {
      return matchesText(candidate, text);
    }) ?? null
  );
}

function menuItemByText(text: RoleTextMatch): HTMLElement {
  const menuItems = queryAllByRoleFast("menuitem");
  const item = menuItems.find((candidate) => {
    return matchesText(candidate, text);
  });
  if (!item) {
    throw new Error(`${matchLabel(text)} menu item not found`);
  }
  return item;
}

describe("agent workflows tab", () => {
  it("shows the agent's workflows and links into the detail page", async () => {
    mockAgentPageApis();
    mockWorkflowApis([
      salesResearch(),
      opsPlaybook(),
      pendingReviewWorkflow(),
      otherAgentWorkflow(),
    ]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows`,
      featureSwitches: { [FeatureSwitchKey.WorkflowsViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });
    expect(screen.getByText("Launch Checklist")).toBeInTheDocument();
    expect(screen.getByText("Ops Playbook")).toBeInTheDocument();
    expect(screen.queryByText("Support Intake")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search workflows")).not.toBeInTheDocument();

    for (const title of [
      "Sales Research",
      "Launch Checklist",
      "Ops Playbook",
    ]) {
      const cardLink = screen.getByText(title).closest("a");
      if (!cardLink) {
        throw new Error(`${title} workflow card link not found`);
      }
      expect(within(cardLink).getByText("Test User")).toBeInTheDocument();
    }

    const pendingHeading = screen.getByRole("heading", {
      name: "Pending review",
    });
    const publicHeading = screen.getByRole("heading", { name: "Public" });
    const privateHeading = screen.getByRole("heading", { name: "Private" });
    expect(
      Boolean(
        pendingHeading.compareDocumentPosition(publicHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBeTruthy();
    expect(
      Boolean(
        publicHeading.compareDocumentPosition(privateHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBeTruthy();

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
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    const breadcrumb = screen.getByLabelText("Breadcrumb");
    const workflowsLink = queryAllByRoleFast("link", breadcrumb).find(
      (link) => {
        return link.textContent?.trim() === "workflows";
      },
    );
    expect(workflowsLink).toHaveAttribute(
      "href",
      `/agents/${AGENT_ID}/workflows`,
    );
    expect(within(breadcrumb).getByText("Agents")).toBeInTheDocument();
    expect(within(breadcrumb).getByText("Research Bot")).toBeInTheDocument();
    expect(within(breadcrumb).getByText("Sales Research")).toBeInTheDocument();
    click(buttonByText(/trigger/i));
    expect(search()).toBe("?sidebar=triggers");
    expect(buttonByText("Close trigger sidebar")).toBeInTheDocument();
    expect(screen.getByText("Weekdays at 9:00 AM")).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByText("Open thread")).toBeInTheDocument();
    click(buttonByText("instructions", breadcrumb));
    click(menuItemByText(/config\/settings\.json/));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Workflow file content"),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Workflow file content")).toHaveValue(
      '{ "risk": "low", "tone": "direct" }',
    );

    await waitFor(() => {
      expect(buttonByText(/permissions/i)).toBeInTheDocument();
    });
    click(buttonByText(/permissions/i));
    await waitFor(() => {
      expect(screen.getByText("Trigger permissions")).toBeInTheDocument();
    });
    expect(
      screen.getByPlaceholderText("Search connectors"),
    ).toBeInTheDocument();
    expect(screen.getByText("Slack")).toBeInTheDocument();
  });

  it("derives the trigger sidebar from workflow detail search params", async () => {
    mockWorkflowApis([salesResearch()]);

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/workflows/${SALES_WORKFLOW_ID}?sidebar=triggers`,
    });

    await waitFor(() => {
      expect(buttonByText("Close trigger sidebar")).toBeInTheDocument();
    });
    expect(screen.getByText("Weekdays at 9:00 AM")).toBeInTheDocument();
    click(buttonByText("Close trigger sidebar"));

    await waitFor(() => {
      expect(
        queryButtonByText("Close trigger sidebar"),
      ).not.toBeInTheDocument();
    });
    expect(search()).toBe("");
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
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    click(buttonByText(/trigger/i));

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
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    click(buttonByText(/trigger/i));
    const addTriggerButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Add trigger";
    });
    expect(addTriggerButton).toBeDefined();
    click(addTriggerButton!);

    await waitFor(() => {
      expect(
        queryAllByRoleFast("menuitem").some((item) => {
          return item.textContent?.includes("Gmail new message");
        }),
      ).toBeTruthy();
    });
    const gmailMenuItem = queryAllByRoleFast("menuitem").find((item) => {
      return item.textContent?.includes("Gmail new message");
    });
    expect(gmailMenuItem).toBeDefined();
    click(gmailMenuItem!);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add Gmail trigger",
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

  it("creates a Gmail label applied trigger with a label name", async () => {
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
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    click(buttonByText(/trigger/i));
    const addTriggerButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.trim() === "Add trigger";
    });
    expect(addTriggerButton).toBeDefined();
    click(addTriggerButton!);

    await waitFor(() => {
      expect(
        queryAllByRoleFast("menuitem").some((item) => {
          return item.textContent?.includes("Gmail label applied");
        }),
      ).toBeTruthy();
    });
    const gmailLabelMenuItem = queryAllByRoleFast("menuitem").find((item) => {
      return item.textContent?.includes("Gmail label applied");
    });
    expect(gmailLabelMenuItem).toBeDefined();
    click(gmailLabelMenuItem!);

    const createTriggerForm = await screen.findByRole("form", {
      name: "Add Gmail label trigger",
    });
    await fill(
      within(createTriggerForm).getByLabelText("Label name"),
      "Support",
    );
    fireEvent.submit(createTriggerForm);

    await waitFor(() => {
      expect(createBodies.at(-1)).toStrictEqual({
        kind: "event",
        eventType: "gmail-label-applied",
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Support",
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
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    click(buttonByText(/trigger/i));

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
            },
          },
        },
      });
    });
  });

  it("updates a Gmail label applied trigger with a label name", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    const workflow = {
      ...salesResearch(),
      triggers: [gmailLabelWorkflowTrigger()],
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
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    click(buttonByText(/trigger/i));

    await waitFor(() => {
      expect(screen.getByText("Gmail label applied")).toBeInTheDocument();
    });
    click(screen.getByText("Edit label"));

    const updateTriggerForm = screen.getByRole("form", {
      name: "Update Gmail label trigger",
    });
    await fill(
      within(updateTriggerForm).getByLabelText("Label name"),
      "Escalated",
    );
    fireEvent.submit(updateTriggerForm);

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: GMAIL_LABEL_TRIGGER_ID,
        body: {
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Escalated",
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
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });
    const breadcrumb = screen.getByLabelText("Breadcrumb");
    click(buttonByText("instructions", breadcrumb));
    click(menuItemByText(/config\/settings\.json/));
    click(buttonByText(/config\/settings\.json/, breadcrumb));
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
      expect(
        screen.getByText("Gather CRM context before outreach."),
      ).toBeInTheDocument();
    });

    const breadcrumb = screen.getByLabelText("Breadcrumb");
    click(buttonByText("instructions", breadcrumb));
    const input = screen.getByLabelText("Upload workflow files");
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

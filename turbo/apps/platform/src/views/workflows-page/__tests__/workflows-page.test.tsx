import { screen, waitFor } from "@testing-library/react";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
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

function workflowTriggers(): ZeroWorkflowTriggerSummary[] {
  return [
    {
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
    },
  ];
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

function mockWorkflowApis(workflows: ZeroWorkflowDetailResponse[]): void {
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
});

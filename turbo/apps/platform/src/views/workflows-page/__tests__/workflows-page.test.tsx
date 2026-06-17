import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowsDetailContract,
  type ZeroWorkflowAgentSummary,
  type ZeroWorkflowDetailResponse,
  type ZeroWorkflowSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const user = userEvent.setup({ delay: null });

function researchAgent(): ZeroWorkflowAgentSummary {
  return {
    agentId: "c0000000-0000-4000-a000-000000000101",
    ownerId: "user-1",
    displayName: "Research Bot",
    description: "Finds account context",
    avatarUrl: "https://assets.example.test/research-bot.png",
    visibility: "public",
  };
}

function supportAgent(): ZeroWorkflowAgentSummary {
  return {
    agentId: "c0000000-0000-4000-a000-000000000102",
    ownerId: "user-1",
    displayName: "Support Bot",
    description: "Triages customer work",
    avatarUrl: null,
    visibility: "public",
  };
}

const WORKFLOW_DETAILS: readonly ZeroWorkflowDetailResponse[] = [
  {
    name: "sales-research",
    displayName: "Sales Research",
    description: "Collects account context before outreach.",
    visibility: "public",
    ownerUserId: "user-1",
    attachedAgentCount: 2,
    attachedAgents: [researchAgent(), supportAgent()],
    canManage: true,
    content: `---
name: Sales Research
---
# Sales research

Use CRM context before outreach.
`,
    files: [
      { path: "SKILL.md", size: 96 },
      { path: "examples/prompt.md", size: 1536 },
      { path: "examples/deep/reference.md", size: 2_097_152 },
      { path: "config/settings.json", size: 32 },
    ],
    fileContents: [
      {
        path: "SKILL.md",
        content: `---
name: Sales Research
---
# Sales research

Use CRM context before outreach.
`,
      },
      {
        path: "examples/prompt.md",
        content: "# Prompt example\n\nAsk for market segment and urgency.\n",
      },
      {
        path: "examples/deep/reference.md",
        content: "# Deep reference\n\nCompare regional pipeline movement.\n",
      },
      {
        path: "config/settings.json",
        content: '{ "risk": "low", "tone": "direct" }',
      },
    ],
  },
  {
    name: "support-escalation",
    displayName: "Support Escalation",
    description: "Summarizes urgent customer issues for the support queue.",
    visibility: "public",
    ownerUserId: "user-1",
    attachedAgentCount: 1,
    attachedAgents: [supportAgent()],
    canManage: true,
    content: "# Support escalation\n\nSummarize severity and next owner.\n",
    files: [{ path: "SKILL.md", size: 64 }],
    fileContents: [
      {
        path: "SKILL.md",
        content: "# Support escalation\n\nSummarize severity and next owner.\n",
      },
    ],
  },
  {
    name: "ops-playbook",
    displayName: "Ops Playbook",
    description: null,
    visibility: "private",
    ownerUserId: "user-1",
    attachedAgentCount: 0,
    attachedAgents: [],
    canManage: true,
    content: "# Ops playbook\n\nPrepare release checks.\n",
    files: [{ path: "SKILL.md", size: 2048 }],
    fileContents: [
      {
        path: "SKILL.md",
        content: "# Ops playbook\n\nPrepare release checks.\n",
      },
    ],
  },
];

function workflowMetadata(): readonly ZeroWorkflowSummary[] {
  return WORKFLOW_DETAILS.map((workflow) => {
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
  });
}

function mockWorkflowApis(): void {
  context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [...workflowMetadata()]);
  });
  context.mocks.api(zeroWorkflowsDetailContract.get, ({ params, respond }) => {
    const detail = WORKFLOW_DETAILS.find((workflow) => {
      return workflow.name === params.name;
    });
    if (!detail) {
      return respond(404, {
        error: {
          code: "NOT_FOUND",
          message: `Workflow not found: ${params.name}`,
        },
      });
    }
    return respond(200, detail);
  });
}

function getButtonContaining(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((el) => {
    return el.textContent?.includes(text);
  });
  if (!button) {
    throw new Error(`Could not find button containing: ${text}`);
  }
  return button;
}

describe("workflows page", () => {
  it("filters workflows and opens a workflow detail with its package files", async () => {
    mockWorkflowApis();

    detachedSetupPage({
      context,
      path: "/workflows",
      featureSwitches: { [FeatureSwitchKey.WorkflowsViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });
    expect(screen.getByText("Support Escalation")).toBeInTheDocument();
    expect(screen.getByText("Ops Playbook")).toBeInTheDocument();
    expect(
      screen.getByLabelText("2 agents attached to this workflow"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Unbound")).toBeInTheDocument();
    expect(screen.getAllByAltText("Research Bot").length).toBeGreaterThan(0);
    expect(screen.getByText("private")).toBeInTheDocument();

    const searchInput = screen.getByLabelText("Search workflows");
    await fill(searchInput, "support");
    await waitFor(() => {
      expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Support Escalation")).toBeInTheDocument();

    await user.click(searchInput);
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Attachment filter"));
    click(await screen.findByRole("option", { name: "Unbound" }));
    await waitFor(() => {
      expect(screen.queryByText("Sales Research")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Ops Playbook")).toBeInTheDocument();

    click(screen.getByLabelText("Attachment filter"));
    click(await screen.findByRole("option", { name: "All" }));
    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Agent filter"));
    click(await screen.findByText("Research Bot"));
    await waitFor(() => {
      expect(screen.queryByText("Support Escalation")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Sales Research")).toBeInTheDocument();

    click(getButtonContaining("Sales Research"));
    await waitFor(() => {
      expect(
        screen.getByText("Use CRM context before outreach."),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("Attached agents")).toBeInTheDocument();
    expect(screen.getByText("Support Bot")).toBeInTheDocument();

    click(screen.getByLabelText("Open examples/prompt.md"));
    await waitFor(() => {
      expect(screen.getByText("Prompt example")).toBeInTheDocument();
    });
    expect(screen.getByText("1.5 KiB")).toBeInTheDocument();
    expect(
      screen.getByText("Ask for market segment and urgency."),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Open examples/deep/reference.md"));
    await waitFor(() => {
      expect(screen.getByText("Deep reference")).toBeInTheDocument();
    });
    expect(screen.getByText("2.0 MiB")).toBeInTheDocument();
    expect(
      screen.getByText("Compare regional pipeline movement."),
    ).toBeInTheDocument();

    click(screen.getByLabelText("Open config/settings.json"));
    await waitFor(() => {
      expect(
        screen.getByText('{ "risk": "low", "tone": "direct" }'),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(
        screen.queryByText("Use CRM context before outreach."),
      ).not.toBeInTheDocument();
    });
  });

  it("redirects the legacy skills route to workflows", async () => {
    mockWorkflowApis();

    detachedSetupPage({
      context,
      path: "/skills",
      featureSwitches: { [FeatureSwitchKey.WorkflowsViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Workflows")).toBeInTheDocument();
    });
    expect(screen.getByText("Sales Research")).toBeInTheDocument();
  });
});

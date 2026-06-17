import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import {
  zeroWorkflowAgentsContract,
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
import { setMockOrg } from "../../../mocks/handlers/api-org.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const user = userEvent.setup({ delay: null });
const CURRENT_USER_ID = "test-user-123";
const OTHER_USER_ID = "user-other";

function researchAgent(): ZeroWorkflowAgentSummary {
  return {
    agentId: "c0000000-0000-4000-a000-000000000101",
    ownerId: CURRENT_USER_ID,
    displayName: "Research Bot",
    description: "Finds account context",
    avatarUrl: "https://assets.example.test/research-bot.png",
    visibility: "public",
  };
}

function supportAgent(): ZeroWorkflowAgentSummary {
  return {
    agentId: "c0000000-0000-4000-a000-000000000102",
    ownerId: CURRENT_USER_ID,
    displayName: "Support Bot",
    description: "Triages customer work",
    avatarUrl: null,
    visibility: "public",
  };
}

function opsAgent(): TeamComposeItem {
  return {
    id: "c0000000-0000-4000-a000-000000000103",
    ownerId: CURRENT_USER_ID,
    displayName: "Ops Bot",
    description: "Runs release checks",
    sound: null,
    avatarUrl: null,
    customSkills: [],
    visibility: "private",
    headVersionId: "version_ops",
    updatedAt: "2026-06-17T00:00:00Z",
  };
}

function sharedAgent(): TeamComposeItem {
  return {
    id: "c0000000-0000-4000-a000-000000000104",
    ownerId: OTHER_USER_ID,
    displayName: "Shared Bot",
    description: "Shared public agent",
    sound: null,
    avatarUrl: null,
    customSkills: [],
    visibility: "public",
    headVersionId: "version_shared",
    updatedAt: "2026-06-17T00:00:00Z",
  };
}

function otherPrivateAgent(): TeamComposeItem {
  return {
    id: "c0000000-0000-4000-a000-000000000105",
    ownerId: OTHER_USER_ID,
    displayName: "Other Private Bot",
    description: "Not configurable by the current user",
    sound: null,
    avatarUrl: null,
    customSkills: [],
    visibility: "private",
    headVersionId: "version_other_private",
    updatedAt: "2026-06-17T00:00:00Z",
  };
}

const BASE_WORKFLOW_DETAILS: readonly ZeroWorkflowDetailResponse[] = [
  {
    name: "sales-research",
    displayName: "Sales Research",
    description: "Collects account context before outreach.",
    visibility: "public",
    ownerUserId: CURRENT_USER_ID,
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
    ownerUserId: CURRENT_USER_ID,
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
    ownerUserId: CURRENT_USER_ID,
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

function mutableWorkflowDetails(): ZeroWorkflowDetailResponse[] {
  return BASE_WORKFLOW_DETAILS.map((workflow) => {
    return {
      ...workflow,
      attachedAgents: [...workflow.attachedAgents],
      files: workflow.files ? [...workflow.files] : workflow.files,
      fileContents: workflow.fileContents
        ? [...workflow.fileContents]
        : workflow.fileContents,
    };
  });
}

function workflowMetadata(
  workflows: readonly ZeroWorkflowDetailResponse[],
): readonly ZeroWorkflowSummary[] {
  return workflows.map((workflow) => {
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

function teamAgentToWorkflowAgent(
  agent: TeamComposeItem,
): ZeroWorkflowAgentSummary {
  return {
    agentId: agent.id,
    ownerId: agent.ownerId ?? "",
    displayName: agent.displayName,
    description: agent.description,
    avatarUrl: agent.avatarUrl,
    visibility: agent.visibility ?? "public",
  };
}

function setAttachedAgents(
  workflows: ZeroWorkflowDetailResponse[],
  workflowName: string,
  agents: readonly ZeroWorkflowAgentSummary[],
): ZeroWorkflowSummary | null {
  const index = workflows.findIndex((workflow) => {
    return workflow.name === workflowName;
  });
  if (index === -1) {
    return null;
  }

  const updated = {
    ...workflows[index]!,
    attachedAgentCount: agents.length,
    attachedAgents: [...agents],
  };
  workflows[index] = updated;
  return workflowMetadata([updated])[0] ?? null;
}

function mockWorkflowApis(
  workflows: ZeroWorkflowDetailResponse[] = mutableWorkflowDetails(),
  team: readonly TeamComposeItem[] = [],
): void {
  const teamById = new Map(
    team.map((agent) => {
      return [agent.id, agent];
    }),
  );
  context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
    return respond(200, [...workflowMetadata(workflows)]);
  });
  context.mocks.api(zeroWorkflowsDetailContract.get, ({ params, respond }) => {
    const detail = workflows.find((workflow) => {
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
  context.mocks.api(
    zeroWorkflowAgentsContract.attach,
    ({ body, params, respond }) => {
      const workflow = workflows.find((item) => {
        return item.name === params.name;
      });
      if (!workflow) {
        return respond(404, {
          error: {
            code: "NOT_FOUND",
            message: `Workflow not found: ${params.name}`,
          },
        });
      }

      const agent = teamById.get(body.agentId);
      if (!agent) {
        return respond(404, {
          error: {
            code: "NOT_FOUND",
            message: `Agent not found: ${body.agentId}`,
          },
        });
      }

      const attachedAgent = teamAgentToWorkflowAgent(agent);
      const summary = setAttachedAgents(workflows, workflow.name, [
        ...workflow.attachedAgents.filter((candidate) => {
          return candidate.agentId !== attachedAgent.agentId;
        }),
        attachedAgent,
      ]);
      return respond(200, summary!);
    },
  );
  context.mocks.api(
    zeroWorkflowAgentsContract.detach,
    ({ params, respond }) => {
      const workflow = workflows.find((item) => {
        return item.name === params.name;
      });
      if (!workflow) {
        return respond(404, {
          error: {
            code: "NOT_FOUND",
            message: `Workflow not found: ${params.name}`,
          },
        });
      }

      const summary = setAttachedAgents(
        workflows,
        workflow.name,
        workflow.attachedAgents.filter((agent) => {
          return agent.agentId !== params.agentId;
        }),
      );
      return respond(200, summary!);
    },
  );
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

  it("attaches and detaches configurable agents from workflow details", async () => {
    const ops = opsAgent();
    const shared = sharedAgent();
    const otherPrivate = otherPrivateAgent();
    const workflows = mutableWorkflowDetails();
    setMockTeam([ops, shared, otherPrivate]);
    setMockOrg({ role: "member" });
    mockWorkflowApis(workflows, [ops, shared, otherPrivate]);

    detachedSetupPage({
      context,
      path: "/workflows",
      featureSwitches: { [FeatureSwitchKey.WorkflowsViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Ops Playbook")).toBeInTheDocument();
    });

    click(getButtonContaining("Ops Playbook"));
    await waitFor(() => {
      expect(
        screen.getByText("Not attached to any agent."),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Attach workflow to agent"));
    const sharedOption = await screen.findByRole("option", {
      name: "Shared Bot",
    });
    expect(sharedOption).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Ops Bot" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Other Private Bot" }),
    ).not.toBeInTheDocument();

    click(screen.getByRole("option", { name: "Shared Bot" }));
    await waitFor(() => {
      expect(screen.getByText("Shared Bot")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Detach workflow from Shared Bot"));
    await waitFor(() => {
      expect(screen.queryByText("Shared Bot")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Not attached to any agent.")).toBeInTheDocument();
  });
});

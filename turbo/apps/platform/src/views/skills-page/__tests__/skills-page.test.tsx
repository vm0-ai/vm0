import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  zeroSkillsCollectionContract,
  zeroSkillsDetailContract,
  type ZeroAgentCustomSkill,
  type ZeroAgentSkillDetailResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import {
  zeroTeamContract,
  type TeamComposeItem,
} from "@vm0/api-contracts/contracts/zero-team";
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

const SKILL_DETAILS: readonly ZeroAgentSkillDetailResponse[] = [
  {
    name: "sales-research",
    displayName: "Sales Research",
    description: "Collects account context before outreach.",
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

const TEAM: readonly TeamComposeItem[] = [
  {
    id: "c0000000-0000-4000-a000-000000000101",
    displayName: "Research Bot",
    description: "Finds account context",
    sound: null,
    avatarUrl: "https://assets.example.test/research-bot.png",
    customSkills: ["sales-research"],
    headVersionId: "version_research",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  {
    id: "c0000000-0000-4000-a000-000000000102",
    displayName: "Support Bot",
    description: "Triages customer work",
    sound: null,
    avatarUrl: null,
    customSkills: ["support-escalation", "sales-research"],
    headVersionId: "version_support",
    updatedAt: "2026-01-01T00:00:00Z",
  },
];

function skillMetadata(): readonly ZeroAgentCustomSkill[] {
  return SKILL_DETAILS.map((skill) => {
    return {
      name: skill.name,
      displayName: skill.displayName,
      description: skill.description,
    };
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

describe("skills page", () => {
  it("filters skills and opens a skill detail with its files", async () => {
    context.mocks.api(zeroTeamContract.list, ({ respond }) => {
      return respond(200, [...TEAM]);
    });
    context.mocks.api(zeroSkillsCollectionContract.list, ({ respond }) => {
      return respond(200, [...skillMetadata()]);
    });
    context.mocks.api(zeroSkillsDetailContract.get, ({ params, respond }) => {
      const detail = SKILL_DETAILS.find((skill) => {
        return skill.name === params.name;
      });
      if (!detail) {
        return respond(404, {
          error: {
            code: "NOT_FOUND",
            message: `Skill not found: ${params.name}`,
          },
        });
      }
      return respond(200, detail);
    });

    detachedSetupPage({
      context,
      path: "/skills",
      featureSwitches: { [FeatureSwitchKey.SkillsViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Sales Research")).toBeInTheDocument();
    });
    expect(screen.getByText("Support Escalation")).toBeInTheDocument();
    expect(
      screen.getByLabelText("2 agents use this skill"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("No agents")).toBeInTheDocument();
    expect(screen.getAllByAltText("Research Bot").length).toBeGreaterThan(0);

    const searchInput = screen.getByLabelText("Search skills");
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
});

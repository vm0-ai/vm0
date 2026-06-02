import { screen, waitFor, within } from "@testing-library/react";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { setMockSkills } from "../../../mocks/handlers/api-skills.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname$ } from "../../../signals/route.ts";

const context = testContext();

const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const WRITER_AGENT_ID = "c0000000-0000-4000-a000-000000000002";

const AGENTS = [
  {
    id: RESEARCH_AGENT_ID,
    ownerId: "user_research",
    displayName: "Research Agent",
    description: null,
    sound: null,
    avatarUrl: "https://example.com/research-agent.png",
    customSkills: ["research-notes"],
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "c0000000-0000-4000-a000-000000000003",
    ownerId: "user_research_2",
    displayName: "Analyst Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: ["research-notes"],
    visibility: "public",
    headVersionId: "version_3",
    updatedAt: "2024-01-03T00:00:00Z",
  },
  {
    id: "c0000000-0000-4000-a000-000000000004",
    ownerId: "user_research_3",
    displayName: "Browser Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: ["research-notes"],
    visibility: "public",
    headVersionId: "version_4",
    updatedAt: "2024-01-04T00:00:00Z",
  },
  {
    id: "c0000000-0000-4000-a000-000000000005",
    ownerId: "user_research_4",
    displayName: "Review Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: ["research-notes"],
    visibility: "public",
    headVersionId: "version_5",
    updatedAt: "2024-01-05T00:00:00Z",
  },
  {
    id: "c0000000-0000-4000-a000-000000000006",
    ownerId: "user_research_5",
    displayName: "Build Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: ["research-notes"],
    visibility: "public",
    headVersionId: "version_6",
    updatedAt: "2024-01-06T00:00:00Z",
  },
  {
    id: "c0000000-0000-4000-a000-000000000007",
    ownerId: "user_research_6",
    displayName: "Ops Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: ["research-notes"],
    visibility: "public",
    headVersionId: "version_7",
    updatedAt: "2024-01-07T00:00:00Z",
  },
  {
    id: WRITER_AGENT_ID,
    ownerId: "user_writer",
    displayName: "Writer Agent",
    description: null,
    sound: null,
    avatarUrl: null,
    customSkills: ["draft-helper"],
    visibility: "public",
    headVersionId: "version_2",
    updatedAt: "2024-01-02T00:00:00Z",
  },
] satisfies TeamComposeItem[];

function setupSkillsPage(): void {
  setMockTeam(AGENTS);
  setMockSkills([
    {
      name: "research-notes",
      displayName: "Research Notes",
      description: "Capture source-backed findings",
      content: "# Research Notes\n\nStart with sources.",
      files: [
        { path: "SKILL.md", size: 37 },
        { path: "templates/prompt.md", size: 12 },
      ],
      fileContents: [
        {
          path: "SKILL.md",
          content: "# Research Notes\n\nStart with sources.",
        },
        { path: "templates/prompt.md", content: "Use the tool" },
      ],
    },
    {
      name: "draft-helper",
      displayName: "Draft Helper",
      description: "Prepare polished drafts",
      content: "# Draft Helper",
      files: [{ path: "SKILL.md", size: 14 }],
      fileContents: [{ path: "SKILL.md", content: "# Draft Helper" }],
    },
  ]);

  detachedSetupPage({
    context,
    path: "/skills",
    featureSwitches: { [FeatureSwitchKey.OrgSkills]: true },
  });
}

describe("skills page", () => {
  it("redirects to home when OrgSkills is disabled", async () => {
    detachedSetupPage({
      context,
      path: "/skills",
      featureSwitches: { [FeatureSwitchKey.OrgSkills]: false },
    });

    await waitFor(() => {
      expect(context.store.get(pathname$)).not.toBe("/skills");
    });
  });

  it("shows custom skills and filters them by agent", async () => {
    setupSkillsPage();

    await waitFor(() => {
      expect(screen.getByText("Research Notes")).toBeInTheDocument();
      expect(screen.getByText("Draft Helper")).toBeInTheDocument();
    });

    expect(screen.getByText("Used by")).toBeInTheDocument();
    const researchRow = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("Research Notes");
    });
    expect(researchRow).toBeDefined();
    expect(
      within(researchRow!).getByAltText("Research Agent"),
    ).toBeInTheDocument();
    expect(within(researchRow!).getByText("+1")).toBeInTheDocument();

    click(screen.getByRole("combobox", { name: "Agent filter" }));
    click(await screen.findByRole("option", { name: "Writer Agent" }));

    await waitFor(() => {
      expect(screen.getByText("Draft Helper")).toBeInTheDocument();
      expect(screen.queryByText("Research Notes")).not.toBeInTheDocument();
    });
  });

  it("opens a read-only skill detail dialog with usage and selectable files", async () => {
    setupSkillsPage();

    click(await screen.findByText("Research Notes"));

    await waitFor(() => {
      expect(screen.getByLabelText("Skill content")).toHaveTextContent(
        "# Research Notes",
      );
    });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Used by")).toBeInTheDocument();
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByAltText("Research Agent")).toBeInTheDocument();
    const promptFileButton = queryAllByRoleFast("button", dialog).find(
      (button) => {
        return button.textContent?.includes("templates/prompt.md");
      },
    );
    expect(promptFileButton).toBeDefined();
    click(promptFileButton!);

    await waitFor(() => {
      expect(screen.getByLabelText("Skill content")).toHaveTextContent(
        "Use the tool",
      );
    });

    expect(
      queryAllByRoleFast("button", dialog).some((button) => {
        return button.textContent === "Save";
      }),
    ).toBeFalsy();
  });
});

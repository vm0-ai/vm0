import { screen, waitFor } from "@testing-library/react";
import type { TeamComposeItem } from "@vm0/api-contracts/contracts/zero-team";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import {
  getMockSkills,
  setMockSkills,
} from "../../../mocks/handlers/api-skills.ts";
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
    avatarUrl: null,
    customSkills: ["research-notes"],
    visibility: "public",
    headVersionId: "version_1",
    updatedAt: "2024-01-01T00:00:00Z",
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

    click(screen.getByRole("combobox", { name: "Agent filter" }));
    click(await screen.findByRole("option", { name: "Writer Agent" }));

    await waitFor(() => {
      expect(screen.getByText("Draft Helper")).toBeInTheDocument();
      expect(screen.queryByText("Research Notes")).not.toBeInTheDocument();
    });
  });

  it("saves SKILL.md edits without dropping extra files", async () => {
    setupSkillsPage();

    const editor = await screen.findByLabelText("Skill instructions");
    await fill(editor, "# Research Notes\n\nUpdated guidance.");

    const saveButton = queryAllByRoleFast("button").find((button) => {
      return button.textContent?.includes("Save");
    });
    if (!saveButton) {
      throw new Error("Save button not found");
    }
    click(saveButton);

    await waitFor(() => {
      const updated = getMockSkills().find((skill) => {
        return skill.name === "research-notes";
      });
      expect(updated?.fileContents).toStrictEqual([
        { path: "SKILL.md", content: "# Research Notes\n\nUpdated guidance." },
        { path: "templates/prompt.md", content: "Use the tool" },
      ]);
    });
  });
});

import { screen, waitFor } from "@testing-library/react";
import {
  zeroMemoryContract,
  type MemoryDetailResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import {
  zeroMemoryActivityContract,
  type MemoryActivityResponse,
} from "@vm0/api-contracts/contracts/zero-memory-activity";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function localDateDaysAgo(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function getTabByText(text: string): HTMLElement {
  const tab = queryAllByRoleFast("tab").find((el) => {
    return el.textContent?.trim() === text;
  });
  if (!tab) {
    throw new Error(`Could not find tab: ${text}`);
  }
  return tab;
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

function memoryDetailResponse(): MemoryDetailResponse {
  return {
    exists: true,
    name: "memory",
    size: 2660,
    fileCount: 3,
    updatedAt: `${localDateDaysAgo(1)}T19:00:00Z`,
    files: [
      { path: "projects.md", size: 512 },
      { path: "MEMORY.md", size: 2048 },
      { path: "notes/settings.json", size: 100 },
    ],
    fileContents: [
      {
        path: "MEMORY.md",
        content: `---
title: Team Memory
description: Cross-functional knowledge
tags:
  - sales
  - support
priority: 2
---
# Working Agreements

Use [Projects](projects.md) for launch plans.
`,
      },
      {
        path: "projects.md",
        content: "# Launch checklist\n\n- Run pricing review\n",
      },
      {
        path: "notes/settings.json",
        content: '{ "tone": "brief" }',
      },
    ],
  };
}

function memoryActivityPage(
  cursor: string | undefined,
): MemoryActivityResponse {
  if (cursor === "older-memory") {
    return {
      entries: [
        {
          date: localDateDaysAgo(2),
          summary: null,
          fromVersionId: "memory-v1",
          toVersionId: "memory-v2",
          items: [
            {
              filePath: "notes/settings.json",
              diff: {
                format: "line",
                beforeExists: true,
                afterExists: true,
                truncated: false,
                stats: { added: 1, removed: 0 },
                hunks: [],
                omittedReason: "too_large",
              },
            },
          ],
        },
      ],
      nextCursor: null,
    };
  }

  return {
    entries: [
      {
        date: localDateDaysAgo(1),
        summary: "Captured **launch preferences** and support context.",
        fromVersionId: null,
        toVersionId: "memory-v1",
        items: [
          {
            filePath: "MEMORY.md",
            diff: {
              format: "line",
              beforeExists: true,
              afterExists: true,
              truncated: false,
              stats: { added: 2, removed: 1 },
              hunks: [
                {
                  beforeStartLine: 1,
                  afterStartLine: 1,
                  lines: [
                    {
                      op: "context",
                      beforeLine: 1,
                      afterLine: 1,
                      text: "# Working Agreements",
                    },
                    {
                      op: "remove",
                      beforeLine: 2,
                      afterLine: null,
                      text: "Use weekly status notes.",
                    },
                    {
                      op: "add",
                      beforeLine: null,
                      afterLine: 2,
                      text: "Prefer pricing review before launch.",
                    },
                    {
                      op: "add",
                      beforeLine: null,
                      afterLine: 3,
                      text: "Route support escalations to Dana.",
                    },
                  ],
                },
              ],
            },
          },
          {
            filePath: "projects.md",
            diff: {
              format: "line",
              beforeExists: false,
              afterExists: true,
              truncated: true,
              stats: { added: 1, removed: 0 },
              hunks: [
                {
                  beforeStartLine: null,
                  afterStartLine: 1,
                  lines: [
                    {
                      op: "add",
                      beforeLine: null,
                      afterLine: 1,
                      text: "- Run pricing review",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
    nextCursor: "older-memory",
  };
}

describe("memory page", () => {
  it("shows memory updates, loads older entries, and browses raw files", async () => {
    context.mocks.api(zeroMemoryActivityContract.get, ({ query, respond }) => {
      return respond(200, memoryActivityPage(query.cursor));
    });
    context.mocks.api(zeroMemoryContract.get, ({ respond }) => {
      return respond(200, memoryDetailResponse());
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("launch preferences")).toBeInTheDocument();
    });
    expect(screen.getByText("2 memory files changed")).toBeInTheDocument();

    click(getButtonContaining("View files"));
    await waitFor(() => {
      expect(screen.getByText("MEMORY.md")).toBeInTheDocument();
    });
    click(getButtonContaining("MEMORY.md"));
    expect(
      screen.getByText("Prefer pricing review before launch."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Route support escalations to Dana."),
    ).toBeInTheDocument();

    click(getButtonContaining("Load more"));
    await waitFor(() => {
      expect(
        screen.getByText("1 memory file changed (+1)."),
      ).toBeInTheDocument();
    });

    click(getTabByText("Memory files"));

    await waitFor(() => {
      expect(screen.getByText("Team Memory")).toBeInTheDocument();
    });
    expect(screen.getByText("Cross-functional knowledge")).toBeInTheDocument();
    expect(screen.getByText("sales, support")).toBeInTheDocument();

    click(screen.getByText("Projects"));
    await waitFor(() => {
      expect(screen.getByText("Launch checklist")).toBeInTheDocument();
    });
    expect(screen.getByText("Run pricing review")).toBeInTheDocument();

    click(getButtonContaining("notes/settings.json"));
    await waitFor(() => {
      expect(screen.getByText('{ "tone": "brief" }')).toBeInTheDocument();
    });
  });
});

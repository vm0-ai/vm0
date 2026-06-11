import { screen, waitFor } from "@testing-library/react";
import {
  zeroMemoryContract,
  type MemoryDetailResponse,
} from "@vm0/api-contracts/contracts/zero-memory";
import { zeroMemoryDevRefreshContract } from "@vm0/api-contracts/contracts/zero-memory-dev-refresh";
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
import { nowDate } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function localDateDaysAgo(daysAgo: number): string {
  const date = nowDate();
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
      { path: "BROKEN.md", size: 220 },
      { path: "empty.md", size: 0 },
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
        path: "BROKEN.md",
        content: `---
title: [broken
---
# Broken Memory

This file keeps rendering when frontmatter is invalid.
`,
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
    context.mocks.api(zeroMemoryDevRefreshContract.refresh, ({ respond }) => {
      return respond(200, { summarized: 2 });
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: {
        [FeatureSwitchKey.MemoryViewer]: true,
        [FeatureSwitchKey.MemoryDevRefresh]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("launch preferences")).toBeInTheDocument();
    });
    expect(screen.getByText("2 memory files changed")).toBeInTheDocument();

    click(screen.getAllByTitle("Force-refresh memory summaries")[0]!);
    await waitFor(() => {
      expect(
        screen.getAllByText("Refreshed 2 memory summaries").length,
      ).toBeGreaterThan(0);
    });

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

    click(getButtonContaining("BROKEN.md"));
    await waitFor(() => {
      expect(screen.getByText("Broken Memory")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "This file keeps rendering when frontmatter is invalid.",
      ),
    ).toBeInTheDocument();

    click(getButtonContaining("empty.md"));
    await waitFor(() => {
      expect(
        screen.getByText("No content available for this file."),
      ).toBeInTheDocument();
    });
  });

  it("shows empty memory activity and raw memory states", async () => {
    context.mocks.api(zeroMemoryActivityContract.get, ({ respond }) => {
      return respond(200, { entries: [], nextCursor: null });
    });
    context.mocks.api(zeroMemoryContract.get, ({ respond }) => {
      return respond(200, {
        exists: false,
        name: "memory",
        size: 0,
        fileCount: 0,
        updatedAt: null,
        files: [],
        fileContents: [],
      });
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("No updates yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Memory-change tracking starts from when this feature launched. As your agents run and Zero learns, daily updates will appear here.",
      ),
    ).toBeInTheDocument();

    click(getTabByText("Memory files"));

    await waitFor(() => {
      expect(screen.getByText("No memory yet")).toBeInTheDocument();
    });
    expect(
      screen.getByText(
        "Zero hasn't recorded any memory yet. It builds up as your agents run and will appear here.",
      ),
    ).toBeInTheDocument();
  });

  it("shows a load-more failure and retries older memory updates", async () => {
    let olderPageAttempts = 0;

    context.mocks.api(zeroMemoryActivityContract.get, ({ query, respond }) => {
      if (query.cursor === "older-memory") {
        olderPageAttempts += 1;
        if (olderPageAttempts === 1) {
          return respond(500, {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Failed to load older memory updates",
            },
          });
        }
      }

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

    click(getButtonContaining("Load more"));
    await waitFor(() => {
      expect(
        screen.getByText("Failed to load older memory updates"),
      ).toBeInTheDocument();
    });

    click(getButtonContaining("Load more"));
    await waitFor(() => {
      expect(
        screen.getByText("1 memory file changed (+1)."),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Failed to load older memory updates"),
    ).not.toBeInTheDocument();
  });
});

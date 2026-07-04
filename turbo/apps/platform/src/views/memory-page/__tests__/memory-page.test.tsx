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
import {
  zeroRelationshipsContract,
  type GmailRelationshipStatusResponse,
  type RelationshipSearchResponse,
} from "@vm0/api-contracts/contracts/zero-relationships";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { toast } from "@vm0/ui/components/ui/sonner";
import { afterEach, describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { nowDate } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

afterEach(() => {
  toast.dismiss();
});

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

function gmailRelationshipStatus(
  overrides: Partial<GmailRelationshipStatusResponse> = {},
): GmailRelationshipStatusResponse {
  return {
    provider: "gmail",
    connectorConnected: true,
    enabled: true,
    watchEnabled: true,
    backfill: {
      status: "done",
      estimatedTotal: 20,
      scannedCount: 20,
      enqueuedCount: 8,
      pendingSyncJobs: 0,
      lastError: null,
      updatedAt: `${localDateDaysAgo(0)}T12:00:00Z`,
      completedAt: `${localDateDaysAgo(0)}T12:00:00Z`,
    },
    ...overrides,
  };
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

function relationshipSearchPage(
  query: string | undefined,
): RelationshipSearchResponse {
  const relationships: RelationshipSearchResponse["relationships"] = [
    {
      id: "00000000-0000-4000-8000-000000000101",
      entity: {
        id: "00000000-0000-4000-8000-000000000102",
        type: "person",
        displayName: "Alice Lee",
        primaryEmail: "alice@acme.com",
        domain: "acme.com",
      },
      relationshipType: "Customer champion",
      status: "active",
      summary:
        "Alice evaluates enterprise automation for Acme and is waiting on a security answer.",
      lastInteractionAt: "2026-07-02T12:00:00.000Z",
      items: [
        {
          id: "00000000-0000-4000-8000-000000000103",
          kind: "open_loop",
          text: "Send the security data-retention answer.",
          confidence: 90,
          lastSeenAt: "2026-07-02T12:00:00.000Z",
          sources: [
            {
              id: "00000000-0000-4000-8000-000000000104",
              provider: "gmail",
              externalId: "gmail-message-1:open_loop:security",
              threadId: "thread-1",
              messageId: "gmail-message-1",
              quote: "Can you send the retention answer?",
              occurredAt: "2026-07-02T12:00:00.000Z",
            },
          ],
        },
      ],
      recentInteractions: [
        {
          id: "00000000-0000-4000-8000-000000000105",
          provider: "gmail",
          externalId: "gmail-message-1",
          threadId: "thread-1",
          messageId: "gmail-message-1",
          subject: "Security review",
          snippet:
            "Asked for security and retention details before the pilot expansion.",
          occurredAt: "2026-07-02T12:00:00.000Z",
        },
      ],
    },
    {
      id: "00000000-0000-4000-8000-000000000201",
      entity: {
        id: "00000000-0000-4000-8000-000000000202",
        type: "organization",
        displayName: "Acme",
        primaryEmail: null,
        domain: "acme.com",
      },
      relationshipType: "Enterprise prospect",
      status: "active",
      summary:
        "Acme is evaluating Zero for internal automation across support and operations.",
      lastInteractionAt: "2026-07-02T12:00:00.000Z",
      items: [
        {
          id: "00000000-0000-4000-8000-000000000203",
          kind: "key_fact",
          text: "Support and operations are the first pilot teams.",
          confidence: 82,
          lastSeenAt: "2026-07-01T12:00:00.000Z",
          sources: [],
        },
      ],
      recentInteractions: [],
    },
    {
      id: "00000000-0000-4000-8000-000000000301",
      entity: {
        id: "00000000-0000-4000-8000-000000000302",
        type: "person",
        displayName: "Mina Johnson",
        primaryEmail: "mina@northstar.io",
        domain: "northstar.io",
      },
      relationshipType: "Partner lead",
      status: "active",
      summary: "Mina coordinates partnership conversations for Northstar.",
      lastInteractionAt: "2026-06-29T12:00:00.000Z",
      items: [
        {
          id: "00000000-0000-4000-8000-000000000303",
          kind: "open_loop",
          text: "Share the partner pricing follow-up.",
          confidence: 88,
          lastSeenAt: "2026-06-29T12:00:00.000Z",
          sources: [],
        },
      ],
      recentInteractions: [],
    },
  ];

  const normalized = query?.toLowerCase().trim();
  return {
    relationships: normalized
      ? relationships.filter((relationship) => {
          return [
            relationship.entity.displayName,
            relationship.entity.primaryEmail,
            relationship.entity.domain,
            relationship.relationshipType,
            relationship.summary,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(normalized);
        })
      : relationships,
  };
}

describe("memory page", () => {
  it("shows debug memory updates and browses raw files", async () => {
    context.mocks.api(zeroMemoryActivityContract.get, ({ query, respond }) => {
      expect(query.limit).toBe(7);
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
        [FeatureSwitchKey.ZeroDebug]: true,
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

  it("hides debug-only memory update controls without ZeroDebug", async () => {
    context.mocks.api(zeroMemoryActivityContract.get, ({ query, respond }) => {
      expect(query.limit).toBe(7);
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
    expect(
      screen.queryByText("2 memory files changed"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("View files")).not.toBeInTheDocument();
    expect(
      screen.queryByTitle("Force-refresh memory summaries"),
    ).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("tab").some((tab) => {
        return tab.textContent?.trim() === "Relationships";
      }),
    ).toBeFalsy();
  });

  it("shows relationship memory when the relationship switch is enabled", async () => {
    context.mocks.api(zeroMemoryActivityContract.get, ({ query, respond }) => {
      expect(query.limit).toBe(7);
      return respond(200, memoryActivityPage(query.cursor));
    });
    context.mocks.api(zeroMemoryContract.get, ({ respond }) => {
      return respond(200, memoryDetailResponse());
    });
    context.mocks.api(
      zeroRelationshipsContract.search,
      ({ query, respond }) => {
        return respond(200, relationshipSearchPage(query.q));
      },
    );
    context.mocks.api(zeroRelationshipsContract.gmailStatus, ({ respond }) => {
      return respond(200, gmailRelationshipStatus());
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: {
        [FeatureSwitchKey.MemoryViewer]: true,
        [FeatureSwitchKey.RelationshipMemory]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("launch preferences")).toBeInTheDocument();
    });

    click(getTabByText("Relationships"));

    await waitFor(() => {
      expect(
        screen.getByText("Customer champion - last touch Jul 2"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("Send the security data-retention answer."),
    ).toBeInTheDocument();
    expect(screen.getByText("This org only")).toBeInTheDocument();

    click(getButtonContaining("Organizations"));

    await waitFor(() => {
      expect(
        screen.getByText("Enterprise prospect - last touch Jul 2"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("Support and operations are the first pilot teams."),
    ).toBeInTheDocument();

    click(getButtonContaining("All"));
    await fill(
      screen.getByPlaceholderText(
        "Search people, companies, emails, or open loops",
      ),
      "northstar",
    );

    await waitFor(() => {
      expect(
        screen.getByText("Partner lead - last touch Jun 29"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByText("Share the partner pricing follow-up."),
    ).toBeInTheDocument();
  });

  it("enables Gmail relationships and shows backfill progress", async () => {
    context.mocks.api(zeroMemoryActivityContract.get, ({ query, respond }) => {
      expect(query.limit).toBe(7);
      return respond(200, memoryActivityPage(query.cursor));
    });
    context.mocks.api(zeroMemoryContract.get, ({ respond }) => {
      return respond(200, memoryDetailResponse());
    });
    context.mocks.api(zeroRelationshipsContract.search, ({ respond }) => {
      return respond(200, { relationships: [] });
    });

    let status = gmailRelationshipStatus({
      enabled: false,
      watchEnabled: false,
      backfill: {
        status: "idle",
        estimatedTotal: null,
        scannedCount: 0,
        enqueuedCount: 0,
        pendingSyncJobs: 0,
        lastError: null,
        updatedAt: null,
        completedAt: null,
      },
    });
    context.mocks.api(zeroRelationshipsContract.gmailStatus, ({ respond }) => {
      return respond(200, status);
    });
    context.mocks.api(zeroRelationshipsContract.gmailEnable, ({ respond }) => {
      status = gmailRelationshipStatus({
        enabled: true,
        watchEnabled: true,
        backfill: {
          status: "pending",
          estimatedTotal: null,
          scannedCount: 0,
          enqueuedCount: 0,
          pendingSyncJobs: 0,
          lastError: null,
          updatedAt: `${localDateDaysAgo(0)}T12:00:00Z`,
          completedAt: null,
        },
      });
      return respond(200, status);
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: {
        [FeatureSwitchKey.MemoryViewer]: true,
        [FeatureSwitchKey.RelationshipMemory]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("launch preferences")).toBeInTheDocument();
    });

    click(getTabByText("Relationships"));

    await waitFor(() => {
      expect(screen.getByText("Enable Gmail")).toBeInTheDocument();
    });

    click(getButtonContaining("Enable Gmail"));

    await waitFor(() => {
      expect(
        screen.getByText("Watch active - Backfilling Gmail - 0 scanned"),
      ).toBeInTheDocument();
    });
  });

  it("starts Gmail backfill when relationships are already enabled but idle", async () => {
    context.mocks.api(zeroMemoryActivityContract.get, ({ query, respond }) => {
      expect(query.limit).toBe(7);
      return respond(200, memoryActivityPage(query.cursor));
    });
    context.mocks.api(zeroMemoryContract.get, ({ respond }) => {
      return respond(200, memoryDetailResponse());
    });
    context.mocks.api(zeroRelationshipsContract.search, ({ respond }) => {
      return respond(200, { relationships: [] });
    });

    let status = gmailRelationshipStatus({
      enabled: true,
      watchEnabled: true,
      backfill: {
        status: "idle",
        estimatedTotal: null,
        scannedCount: 0,
        enqueuedCount: 0,
        pendingSyncJobs: 0,
        lastError: null,
        updatedAt: null,
        completedAt: null,
      },
    });
    context.mocks.api(zeroRelationshipsContract.gmailStatus, ({ respond }) => {
      return respond(200, status);
    });
    context.mocks.api(zeroRelationshipsContract.gmailEnable, ({ respond }) => {
      status = gmailRelationshipStatus({
        enabled: true,
        watchEnabled: true,
        backfill: {
          status: "pending",
          estimatedTotal: null,
          scannedCount: 0,
          enqueuedCount: 0,
          pendingSyncJobs: 0,
          lastError: null,
          updatedAt: `${localDateDaysAgo(0)}T12:00:00Z`,
          completedAt: null,
        },
      });
      return respond(200, status);
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: {
        [FeatureSwitchKey.MemoryViewer]: true,
        [FeatureSwitchKey.RelationshipMemory]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("launch preferences")).toBeInTheDocument();
    });

    click(getTabByText("Relationships"));

    await waitFor(() => {
      expect(screen.getByText("Start backfill")).toBeInTheDocument();
    });

    click(getButtonContaining("Start backfill"));

    await waitFor(() => {
      expect(
        screen.getByText("Watch active - Backfilling Gmail - 0 scanned"),
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

  it("shows at most the seven most recent memory updates", async () => {
    context.mocks.api(zeroMemoryActivityContract.get, ({ query, respond }) => {
      expect(query.limit).toBe(7);
      return respond(200, {
        entries: Array.from({ length: 8 }, (_, index) => {
          return {
            date: localDateDaysAgo(index + 1),
            summary: `Memory update ${index + 1}`,
            fromVersionId: index === 0 ? null : `memory-v${index}`,
            toVersionId: `memory-v${index + 1}`,
            items: [
              {
                filePath: `memory-${index + 1}.md`,
                diff: {
                  format: "line" as const,
                  beforeExists: true,
                  afterExists: true,
                  truncated: false,
                  stats: { added: 1, removed: 0 },
                  hunks: [],
                },
              },
            ],
          };
        }),
        nextCursor: "older-memory",
      });
    });

    detachedSetupPage({
      context,
      path: "/memory",
      featureSwitches: { [FeatureSwitchKey.MemoryViewer]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Memory update 1")).toBeInTheDocument();
    });
    expect(screen.getByText("Memory update 7")).toBeInTheDocument();
    expect(screen.queryByText("Memory update 8")).not.toBeInTheDocument();
    expect(screen.queryByText("Load more")).not.toBeInTheDocument();
  });
});

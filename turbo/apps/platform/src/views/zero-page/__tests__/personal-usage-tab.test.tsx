import {
  zeroBillingStatusContract,
  zeroBillingUsagePackCreditsContract,
  type UsagePackCreditsResponse,
} from "@okouai/api-contracts/contracts/zero-billing";
import {
  zeroUsageRecordContract,
  type UsageRecordRow,
} from "@okouai/api-contracts/contracts/zero-usage-record";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function buttonByAriaLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function usageRows(): UsageRecordRow[] {
  return [
    {
      source: "chat",
      threadId: "thread-planning",
      runId: null,
      title: "Quarterly planning chat",
      credits: 983,
      tokens: 2200,
      breakdown: [
        {
          kind: "other",
          credits: 983,
          providers: [
            {
              provider: "firecrawl",
              credits: 180,
              usageKinds: [{ kind: "scrape", credits: 180 }],
            },
            {
              provider: "google-maps",
              credits: 200,
              usageKinds: [{ kind: "maps", credits: 200 }],
            },
            {
              provider: "perplexity",
              credits: 200,
              usageKinds: [
                { kind: "people-search", credits: 80 },
                { kind: "web-search", credits: 120 },
              ],
            },
            {
              provider: "apidojo",
              credits: 200,
              usageKinds: [{ kind: "finance", credits: 200 }],
            },
            {
              provider: "google-weather",
              credits: 200,
              usageKinds: [{ kind: "weather", credits: 200 }],
            },
            {
              provider: "qwen/qwen-2.5-7b-instruct",
              credits: 3,
              usageKinds: [
                {
                  kind: "translation/qwen/qwen-2.5-7b-instruct/tokens.output",
                  credits: 3,
                },
              ],
            },
          ],
        },
      ],
      member: null,
      lastActivityAt: "2026-03-21T10:00:00Z",
    },
    {
      source: "slack",
      threadId: null,
      runId: "run-slack-follow-up",
      title: "Slack customer follow-up",
      credits: 2400,
      tokens: 5100,
      breakdown: [],
      member: null,
      lastActivityAt: "2026-03-20T10:00:00Z",
    },
    ...Array.from({ length: 18 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return {
        source: "automation",
        threadId: `thread-scheduled-${index}`,
        runId: null,
        title: `Scheduled digest ${index + 1}`,
        credits: 100 + index,
        tokens: 1000 + index,
        breakdown: [],
        member: null,
        lastActivityAt: `2026-03-${day}T10:00:00Z`,
      } satisfies UsageRecordRow;
    }),
    {
      source: "agent",
      threadId: null,
      runId: "run-agent-audit",
      title: "Extended agent audit",
      credits: 3100,
      tokens: 7300,
      breakdown: [],
      member: null,
      lastActivityAt: "2026-02-28T10:00:00Z",
    },
  ];
}

function usageRow(args: {
  readonly title: string;
  readonly credits: number;
  readonly runId: string;
}): UsageRecordRow {
  return {
    source: "chat",
    threadId: null,
    runId: args.runId,
    title: args.title,
    credits: args.credits,
    tokens: 1000,
    breakdown: [],
    member: null,
    lastActivityAt: "2026-03-21T10:00:00Z",
  };
}

function mockBillingStatus(tier: "limited-free-1" | "pro" = "pro"): void {
  context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
    return respond(200, {
      tier,
      supportByok: tier !== "limited-free-1",
      restrictedVm0Models: tier === "limited-free-1",
      credits: 12_500,
      onboardingPaymentPending: false,
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-04-01T00:00:00Z",
      cancelAtPeriodEnd: false,
      scheduledChange: null,
      hasSubscription: true,
      autoRecharge: { enabled: false, threshold: null, amount: null },
      creditExpiry: {
        expiringNextCycle: 0,
        nextExpiryDate: null,
      },
      creditBreakdown: [
        {
          category: "plan",
          tier: "pro",
          label: "Pro credits",
          credits: 10_000,
        },
        {
          category: "promotional",
          label: "Launch bonus",
          credits: 2500,
        },
      ],
      creditGrants: [],
      concurrencyLimit: 0,
      concurrencySubscriptions: [],
    });
  });
}

function mockEmptyUsagePackCredits(): void {
  context.mocks.api(zeroBillingUsagePackCreditsContract.get, ({ respond }) => {
    return respond(200, {
      totalCredits: 0,
      purchasedCredits: 0,
      bonusCredits: 0,
      creditGrants: [],
      hasUsagePack: false,
    });
  });
}

function mockPersonalUsageStory(
  rows: UsageRecordRow[] = usageRows(),
  tier: "limited-free-1" | "pro" = "pro",
  mockUsagePackCredits = true,
  role: "admin" | "member" = "admin",
): string[] {
  const requestedRanges: string[] = [];

  context.mocks.data.org({
    id: "org_1",
    name: "Test Org",
    role,
  });
  mockBillingStatus(tier);
  context.mocks.api(zeroUsageRecordContract.get, ({ query, respond }) => {
    requestedRanges.push(query.range);
    const offset = (query.page - 1) * query.pageSize;

    return respond(200, {
      period: {
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-04-01T00:00:00.000Z",
      },
      rows: rows.slice(offset, offset + query.pageSize),
      totalCredits: rows.reduce((sum, row) => {
        return sum + row.credits;
      }, 0),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total: rows.length,
      },
    });
  });
  if (mockUsagePackCredits) {
    mockEmptyUsagePackCredits();
  }
  return requestedRanges;
}

async function openUsageSettings(
  usagePackPlansEnabled = true,
  section: "usage" | "usage-records" = "usage",
): Promise<void> {
  detachedSetupPage({
    context,
    path: `/?settings=${section}`,
    featureSwitches: usagePackPlansEnabled
      ? { [FeatureSwitchKey.UsagePackPlans]: true }
      : undefined,
  });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  if (!usagePackPlansEnabled) {
    await screen.findByRole("heading", { name: "Preference" });
  }
}

describe("personal usage settings", () => {
  it("does not request or show usage pack credits when the switch is disabled", async () => {
    mockPersonalUsageStory(usageRows(), "pro", false, "member");
    let usagePackCreditRequests = 0;
    context.mocks.api(
      zeroBillingUsagePackCreditsContract.get,
      ({ respond }) => {
        usagePackCreditRequests += 1;
        return respond(200, {
          totalCredits: 20_400,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          creditGrants: [],
        });
      },
    );

    await openUsageSettings(false);
    // Without the new pricing a member has neither an organization balance nor
    // a records section to open.
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.textContent === "Credit balance";
      }),
    ).toBeFalsy();
    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.textContent === "Credit usage";
      }),
    ).toBeFalsy();
    expect(screen.queryByTestId("usage-pack-credit-card")).toBeNull();
    expect(usagePackCreditRequests).toBe(0);
  });

  it("shows the member's usage pack credit breakdown when the switch is enabled", async () => {
    const user = userEvent.setup();
    mockPersonalUsageStory(usageRows(), "pro", false, "member");
    context.mocks.api(
      zeroBillingUsagePackCreditsContract.get,
      ({ respond }) => {
        return respond(200, {
          totalCredits: 20_400,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          hasUsagePack: true,
          creditGrants: [
            {
              id: "grant-purchased",
              grantType: "purchased",
              amount: 25_000,
              remaining: 20_000,
              createdAt: "2026-03-01T00:00:00.000Z",
              expiresAt: "2026-04-01T00:00:00.000Z",
            },
            {
              id: "grant-bonus",
              grantType: "bonus",
              amount: 400,
              remaining: 400,
              createdAt: "2026-03-01T00:00:00.000Z",
              expiresAt: "2026-04-01T00:00:00.000Z",
            },
          ],
        });
      },
    );

    await openUsageSettings(true);

    const card = await screen.findByTestId("usage-pack-credit-card");
    expect(within(card).getByText("Usage pack credits")).toBeInTheDocument();
    expect(
      within(card).getByTestId("usage-pack-credit-purchased"),
    ).toBeInTheDocument();
    expect(
      within(card).getByTestId("usage-pack-credit-bonus"),
    ).toBeInTheDocument();
    expect(
      within(card).getByTestId("usage-pack-credit-grants-toggle"),
    ).toBeInTheDocument();
    expect(within(card).getByText("20,400")).toBeInTheDocument();
    expect(within(card).getAllByText("Purchased")).toHaveLength(2);
    expect(within(card).getByText("20,000")).toBeInTheDocument();
    expect(within(card).getAllByText("Bonus")).toHaveLength(2);
    expect(within(card).getAllByText("400")).toHaveLength(2);
    expect(screen.queryByTestId("credit-balance-info")).toBeNull();
    expect(screen.queryByText("Team usage")).toBeNull();
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.queryByText("Quarterly planning chat")).toBeNull();

    await user.hover(within(card).getByTestId("usage-pack-credit-purchased"));
    await expect(
      screen.findByText("Purchased — 20,000"),
    ).resolves.toBeInTheDocument();
    await expect(
      screen.findByText("Expires Apr 1, 2026"),
    ).resolves.toBeInTheDocument();

    await user.click(
      within(card).getByTestId("usage-pack-credit-grants-toggle"),
    );
    expect(
      within(card).getByTestId("usage-pack-credit-grants-section"),
    ).toHaveAttribute("open");
    expect(
      within(card).getByTestId("usage-pack-credit-grants-grant-purchased"),
    ).toHaveTextContent("Purchased");
    expect(
      within(card).getByTestId("usage-pack-credit-grants-grant-purchased"),
    ).toHaveTextContent("20,000 left");
  });

  it("hides usage pack credits when the organization has no active pack", async () => {
    let requests = 0;
    mockPersonalUsageStory(usageRows(), "pro", false, "member");
    context.mocks.api(
      zeroBillingUsagePackCreditsContract.get,
      ({ respond }) => {
        requests += 1;
        return respond(200, {
          totalCredits: 0,
          purchasedCredits: 0,
          bonusCredits: 0,
          creditGrants: [],
          hasUsagePack: false,
        });
      },
    );

    await openUsageSettings(true);

    await waitFor(() => {
      expect(requests).toBe(1);
    });
    expect(screen.queryByTestId("usage-pack-credit-card")).toBeNull();
  });

  it("hides member balances when the admin is the only member", async () => {
    mockPersonalUsageStory(usageRows(), "pro", false, "admin");
    context.mocks.data.orgMembers({
      name: "Test Org",
      role: "admin",
      createdAt: "2026-01-01T00:00:00.000Z",
      members: [
        {
          userId: "test-user-123",
          email: "linghan@example.com",
          firstName: "Linghan",
          lastName: "Hu",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      pendingInvitations: [],
      membershipRequests: [],
    });
    context.mocks.api(
      zeroBillingUsagePackCreditsContract.get,
      ({ respond }) => {
        return respond(200, {
          totalCredits: 20_000,
          purchasedCredits: 20_000,
          bonusCredits: 0,
          creditGrants: [],
          hasUsagePack: true,
          memberCredits: [
            {
              memberId: "test-user-123",
              totalCredits: 20_000,
              purchasedCredits: 20_000,
              bonusCredits: 0,
              creditGrants: [],
            },
          ],
        });
      },
    );

    await openUsageSettings(true);

    const card = await screen.findByTestId("usage-pack-credit-card");
    await waitFor(() => {
      expect(
        queryAllByRoleFast("button", card).some((button) => {
          return button.getAttribute("aria-label") === "View member balances";
        }),
      ).toBeFalsy();
    });
  });

  it("shows every member's usage pack balance to an admin", async () => {
    const user = userEvent.setup();
    mockPersonalUsageStory(usageRows(), "pro", false, "admin");
    context.mocks.data.orgMembers({
      name: "Test Org",
      role: "admin",
      createdAt: "2026-01-01T00:00:00.000Z",
      members: [
        {
          userId: "test-user-123",
          email: "linghan@example.com",
          firstName: "Linghan",
          lastName: "Hu",
          imageUrl: "",
          role: "admin",
          joinedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          userId: "member-yuma",
          email: "yuma@example.com",
          firstName: "Yuma",
          lastName: null,
          imageUrl: "",
          role: "member",
          joinedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    const linghanCreditGrants = [
      {
        id: "admin-grant-purchased",
        grantType: "purchased",
        amount: 20_000,
        remaining: 20_000,
        createdAt: "2026-03-01T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
      },
      {
        id: "admin-grant-bonus",
        grantType: "bonus",
        amount: 400,
        remaining: 400,
        createdAt: "2026-03-01T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
      },
    ] satisfies UsagePackCreditsResponse["creditGrants"];
    context.mocks.api(
      zeroBillingUsagePackCreditsContract.get,
      ({ respond }) => {
        return respond(200, {
          totalCredits: 20_400,
          purchasedCredits: 20_000,
          bonusCredits: 400,
          creditGrants: linghanCreditGrants,
          hasUsagePack: true,
          memberCredits: [
            {
              memberId: "test-user-123",
              totalCredits: 20_400,
              purchasedCredits: 20_000,
              bonusCredits: 400,
              creditGrants: linghanCreditGrants,
            },
          ],
        });
      },
    );

    await openUsageSettings(true);

    const card = await screen.findByTestId("usage-pack-credit-card");
    expect(within(card).getByText("Usage pack credits")).toBeInTheDocument();
    expect(within(card).queryByText("Linghan Hu")).toBeNull();
    expect(within(card).queryByText("Yuma")).toBeNull();
    expect(
      within(card).getByTestId("usage-pack-credit-bar"),
    ).toBeInTheDocument();
    expect(
      within(card).getByTestId("usage-pack-credit-grants-toggle"),
    ).toBeInTheDocument();

    await user.click(buttonByAriaLabel("View member balances", card));
    const memberDialog = await screen.findByRole("dialog", {
      name: "Member usage pack credits",
    });
    const table = within(memberDialog).getByRole("table");
    expect(within(table).getByText("Member")).toBeInTheDocument();
    expect(within(table).getByText("Remaining")).toBeInTheDocument();
    expect(within(table).getByText("Purchased")).toBeInTheDocument();
    expect(within(table).getByText("Bonus")).toBeInTheDocument();
    expect(within(table).getByText("Next expiry")).toBeInTheDocument();
    expect(within(table).getByText("Credit additions")).toBeInTheDocument();
    expect(within(table).getByText("Linghan Hu")).toBeInTheDocument();
    expect(within(table).getByText("linghan@example.com")).toBeInTheDocument();
    expect(within(table).getByText("Yuma")).toBeInTheDocument();
    expect(within(table).getByText("yuma@example.com")).toBeInTheDocument();
    expect(
      within(table).queryByTestId("usage-pack-member-test-user-123-bar"),
    ).toBeNull();
    expect(
      within(table).getByTestId(
        "usage-pack-member-test-user-123-grants-toggle",
      ),
    ).toBeInTheDocument();
    expect(
      within(table).getByTestId("usage-pack-member-credit-test-user-123"),
    ).toHaveTextContent("20,400");
    expect(
      within(table).getByTestId("usage-pack-member-credit-member-yuma"),
    ).toHaveTextContent("0");
    expect(within(table).getByText("Apr 1, 2026")).toBeInTheDocument();
    expect(within(table).queryByText(/credits remaining/)).toBeNull();

    const summary = within(memberDialog).getByTestId(
      "usage-pack-member-summary",
    );
    expect(summary).toHaveTextContent("2Members");
    expect(summary).toHaveTextContent("20,400Total remaining");
    expect(summary).toHaveTextContent("2Credit additions");

    await user.click(
      within(table).getByTestId(
        "usage-pack-member-test-user-123-grants-toggle",
      ),
    );
    expect(
      within(table).getByTestId(
        "usage-pack-member-test-user-123-grants-toggle",
      ),
    ).toHaveAttribute("aria-expanded", "true");
    const expandedRow = await within(table).findByTestId(
      "usage-pack-member-test-user-123-grants-expanded-row",
    );
    const purchaseRecord = within(expandedRow).getByTestId(
      "usage-pack-member-test-user-123-grants-admin-grant-purchased",
    );
    expect(purchaseRecord).toHaveTextContent("Purchased");
    expect(
      within(memberDialog).getByTestId("usage-pack-members-dialog-scroll-area"),
    ).toHaveClass("overflow-y-auto");
    expect(
      screen.queryByTestId(
        "usage-pack-member-test-user-123-grants-scroll-area",
      ),
    ).toBeNull();
    await user.hover(purchaseRecord);
    expect(screen.queryByRole("tooltip")).toBeNull();

    const orgCredits = await screen.findByTestId("credit-balance-info");
    expect(within(orgCredits).getByText("Org credits")).toBeInTheDocument();
    expect(within(orgCredits).getByText("12,500")).toBeInTheDocument();
  });

  it("shows an illustrated empty state when the range has no usage", async () => {
    mockPersonalUsageStory([]);
    await openUsageSettings(true, "usage-records");

    const empty = await screen.findByTestId("usage-records-empty");
    expect(
      within(empty).getByText("No usage in this time range"),
    ).toBeInTheDocument();
    expect(
      within(empty).getByText(
        "Credits you spend on chats, automations, and channels show up here.",
      ),
    ).toBeInTheDocument();
    // The illustration is decorative, so it must stay out of the accessible name.
    expect(within(empty).getByRole("presentation")).toHaveAttribute(
      "src",
      expect.stringContaining("empty-usage-"),
    );
  });

  it("shows personal usage, loads more, and changes the usage range", async () => {
    const user = userEvent.setup();
    const requestedRanges = mockPersonalUsageStory();
    await openUsageSettings(true, "usage-records");

    await waitFor(() => {
      expect(screen.getByText("Quarterly planning chat")).toBeInTheDocument();
      expect(screen.getByText("Slack customer follow-up")).toBeInTheDocument();
    });
    expect(screen.getByText("983")).toBeInTheDocument();
    expect(screen.queryByText("Extended agent audit")).not.toBeInTheDocument();
    expect(screen.queryByText("All sources")).not.toBeInTheDocument();
    expect(requestedRanges).toContain("today");

    await user.hover(screen.getByTestId("usage-kind-segment-other"));

    await waitFor(() => {
      expect(screen.getAllByText("Web Fetch").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Maps").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Web Search").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        screen.getAllByText("People Search").length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        screen.getAllByText("People Search").some((element) => {
          return element.parentElement?.textContent === "People Search80";
        }),
      ).toBeTruthy();
      expect(
        screen.getAllByText("Web Search").some((element) => {
          return element.parentElement?.textContent === "Web Search120";
        }),
      ).toBeTruthy();
      expect(screen.getAllByText("Finance").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Weather").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Translation").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.queryByText("Firecrawl")).not.toBeInTheDocument();
      expect(screen.queryByText("Google Maps")).not.toBeInTheDocument();
      expect(screen.queryByText("Perplexity")).not.toBeInTheDocument();
      expect(screen.queryByText("Apidojo")).not.toBeInTheDocument();
      expect(screen.queryByText("Google Weather")).not.toBeInTheDocument();
      expect(
        screen.queryByText("qwen/qwen-2.5-7b-instruct"),
      ).not.toBeInTheDocument();
    });

    click(screen.getByText("Load more"));

    await waitFor(() => {
      expect(screen.getByText("Extended agent audit")).toBeInTheDocument();
    });

    click(screen.getByText("Today"));
    click(await screen.findByText("Last 7 days"));

    await waitFor(() => {
      expect(screen.getByText("Last 7 days")).toBeInTheDocument();
      expect(requestedRanges).toContain("7d");
    });
  });

  it("shows model names for limited-free-1 usage", async () => {
    const user = userEvent.setup();
    const row = usageRow({
      title: "Limited free model usage",
      credits: 100,
      runId: "run-limited-free-model",
    });
    mockPersonalUsageStory(
      [
        {
          ...row,
          breakdown: [
            {
              kind: "model",
              credits: 100,
              providers: [{ provider: "gpt-5.6-luna", credits: 100 }],
            },
          ],
        },
      ],
      "limited-free-1",
    );
    await openUsageSettings(true, "usage-records");

    await user.hover(screen.getByTestId("usage-kind-segment-model"));

    await waitFor(() => {
      expect(screen.getAllByText("GPT 5.6 Luna").length).toBeGreaterThanOrEqual(
        1,
      );
    });
  });

  it("hides the vendor name for talking avatar usage", async () => {
    const user = userEvent.setup();
    const row = usageRow({
      title: "Talking avatar usage",
      credits: 100,
      runId: "run-talking-avatar",
    });
    mockPersonalUsageStory([
      {
        ...row,
        breakdown: [
          {
            kind: "video",
            credits: 100,
            providers: [{ provider: "joggai-talking-avatar", credits: 100 }],
          },
        ],
      },
    ]);
    await openUsageSettings(true, "usage-records");

    await user.hover(screen.getByTestId("usage-kind-segment-video"));

    await waitFor(() => {
      expect(
        screen.getAllByText("Avatar").some((element) => {
          return element.parentElement?.textContent === "Avatar100";
        }),
      ).toBeTruthy();
      expect(screen.queryByText(/joggai/iu)).not.toBeInTheDocument();
    });
  });

  it("keeps keyboard focus styling on the usage title instead of the row", async () => {
    mockPersonalUsageStory();
    await openUsageSettings(true, "usage-records");

    const titleLink = await screen.findByText("Quarterly planning chat");

    titleLink.focus();
    expect(titleLink).toHaveFocus();
    expect(titleLink.parentElement?.closest("a")).toBeNull();
    expect(titleLink).toHaveClass(
      "focus-visible:outline-none",
      "focus-visible:ring-inset",
    );
  });

  it("refreshes personal usage when billing realtime changes", async () => {
    context.mocks.data.org({
      id: "org_1",
      name: "Test Org",
      role: "admin",
    });
    mockBillingStatus();
    let usageRequests = 0;
    context.mocks.api(zeroUsageRecordContract.get, ({ query, respond }) => {
      usageRequests += 1;
      const rows =
        usageRequests === 1
          ? [
              usageRow({
                title: "Initial usage row",
                credits: 100,
                runId: "run-initial",
              }),
            ]
          : [
              usageRow({
                title: "Realtime refreshed usage",
                credits: 450,
                runId: "run-refreshed",
              }),
            ];
      return respond(200, {
        period: {
          start: "2026-03-01T00:00:00.000Z",
          end: "2026-04-01T00:00:00.000Z",
        },
        rows,
        totalCredits: rows.reduce((sum, row) => {
          return sum + row.credits;
        }, 0),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: rows.length,
        },
      });
    });
    mockEmptyUsagePackCredits();

    await openUsageSettings(true, "usage-records");

    await waitFor(() => {
      expect(screen.getByText("Initial usage row")).toBeInTheDocument();
      expect(
        context.mocks.ably.hasSubscription("billing:changed"),
      ).toBeTruthy();
    });

    context.mocks.ably.trigger("billing:changed");

    await waitFor(() => {
      expect(screen.getByText("Realtime refreshed usage")).toBeInTheDocument();
      expect(screen.queryByText("Initial usage row")).not.toBeInTheDocument();
    });
  });
});

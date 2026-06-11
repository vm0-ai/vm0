import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type {
  UsageRecordResponse,
  UsageRecordRow,
  UsageRecordSource,
} from "@vm0/api-contracts/contracts/zero-usage-record";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import {
  click,
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { resetMockBilling } from "../../../mocks/handlers/api-billing.ts";
import { resetMockOrg, setMockOrg } from "../../../mocks/handlers/api-org.ts";
import {
  resetMockUsageRecord,
  setMockUsageRecord,
} from "../../../mocks/handlers/api-usage-record.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openSettingsDialogAt$ } from "../../../signals/zero-page/settings/settings-dialog.ts";

const context = testContext();

function usageRow(args: {
  title: string;
  source: UsageRecordSource;
  index: number;
  memberEmail?: string;
}): UsageRecordRow {
  const suffix = args.index.toString().padStart(12, "0");
  return {
    source: args.source,
    threadId:
      args.source === "chat" ? `00000000-0000-4000-a000-${suffix}` : null,
    runId: args.source === "chat" ? null : `10000000-0000-4000-a000-${suffix}`,
    title: args.title,
    credits: args.index * 10,
    tokens: args.index * 100,
    breakdown: [
      {
        kind: "model",
        credits: args.index * 10,
        providers: [
          { provider: "claude-sonnet-4-6", credits: args.index * 10 },
        ],
      },
    ],
    member: args.memberEmail
      ? { userId: `user_${suffix}`, email: args.memberEmail }
      : null,
    lastActivityAt: `2026-03-${args.index.toString().padStart(2, "0")}T12:00:00.000Z`,
  };
}

function setUsageRows(rows: UsageRecordRow[]): void {
  const response: UsageRecordResponse = {
    period: {
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-02T00:00:00.000Z",
    },
    rows,
    pagination: { page: 1, pageSize: 20, total: rows.length },
  };
  setMockUsageRecord(response);
}

async function openCreditBalanceSection({
  creditUsageRecords = true,
}: {
  readonly creditUsageRecords?: boolean;
} = {}): Promise<HTMLElement> {
  detachedSetupPage({
    context,
    path: "/",
    ...(creditUsageRecords
      ? {
          featureSwitches: {
            [FeatureSwitchKey.CreditUsageRecords]: true,
          },
        }
      : {}),
  });
  await waitFor(() => {
    expect(screen.getByText("Default Org")).toBeInTheDocument();
  });

  await context.store.set(openSettingsDialogAt$, "usage", context.signal);

  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  return screen.getByRole("dialog");
}

function findByFastRoleText(
  role: Parameters<typeof queryAllByRoleFast>[0],
  label: string | RegExp,
  container?: ParentNode,
): HTMLElement {
  const element = queryAllByRoleFast(role, container).find((el) => {
    const text = el.textContent?.trim() ?? "";
    return typeof label === "string" ? text === label : label.test(text);
  });
  if (!element) {
    throw new Error(`Unable to find ${role} with label ${label.toString()}`);
  }
  return element;
}

beforeEach(() => {
  resetMockBilling();
  resetMockOrg();
  resetMockUsageRecord();
});

describe("credit balance settings section", () => {
  it("opens credit usage for non-admin members without team or balance controls", async () => {
    setMockOrg({ role: "member" });
    setUsageRows([
      usageRow({ title: "Member chat", source: "chat", index: 1 }),
    ]);

    const dialog = await openCreditBalanceSection();

    await waitFor(() => {
      expect(within(dialog).getByText("Member chat")).toBeInTheDocument();
    });
    expect(within(dialog).getAllByText("Credit usage").length).toBeGreaterThan(
      0,
    );
    expect(within(dialog).getByText("Today")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Credit balance"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Team usage")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("All sources")).not.toBeInTheDocument();
  });

  it("keeps ranged usage controls behind the credit usage records switch", async () => {
    setMockOrg({ role: "member" });
    setUsageRows([
      usageRow({ title: "Member chat", source: "chat", index: 1 }),
    ]);

    const dialog = await openCreditBalanceSection({
      creditUsageRecords: false,
    });

    await waitFor(() => {
      expect(within(dialog).getByText("Member chat")).toBeInTheDocument();
    });
    expect(
      within(dialog).getAllByText("Credit balance").length,
    ).toBeGreaterThan(0);
    expect(within(dialog).getByText("All sources")).toBeInTheDocument();
    expect(within(dialog).queryByText("Today")).not.toBeInTheDocument();
  });

  it("closes the settings dialog when a usage row is clicked", async () => {
    setMockOrg({ role: "member" });
    setUsageRows([
      usageRow({ title: "Member chat", source: "chat", index: 1 }),
    ]);

    const dialog = await openCreditBalanceSection();

    await waitFor(() => {
      expect(within(dialog).getByText("Member chat")).toBeInTheDocument();
    });

    click(within(dialog).getByText("Member chat"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps the settings dialog open when a usage row is opened in a new tab", async () => {
    setMockOrg({ role: "member" });
    setUsageRows([
      usageRow({ title: "Member chat", source: "chat", index: 1 }),
    ]);

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => {
      return null;
    });

    try {
      const dialog = await openCreditBalanceSection();

      await waitFor(() => {
        expect(within(dialog).getByText("Member chat")).toBeInTheDocument();
      });

      const rowLink = within(dialog).getByText("Member chat").closest("a");
      expect(rowLink).not.toBeNull();

      fireEvent.click(rowLink as HTMLElement, { metaKey: true });

      await waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            "/chats/00000000-0000-4000-a000-000000000001",
          ),
          "_blank",
        );
      });
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        within(screen.getByRole("dialog")).getByText("Member chat"),
      ).toBeInTheDocument();
    } finally {
      openSpy.mockRestore();
    }
  });

  it("loads additional personal rows and changes the usage range", async () => {
    setMockOrg({ role: "member" });
    setUsageRows([
      ...Array.from({ length: 20 }, (_, index) => {
        const n = index + 1;
        return usageRow({
          title: `Chat ${n.toString().padStart(2, "0")}`,
          source: "chat",
          index: n,
        });
      }),
      usageRow({ title: "Slack ticket", source: "slack", index: 21 }),
    ]);

    const dialog = await openCreditBalanceSection();

    await waitFor(() => {
      expect(within(dialog).getByText("Chat 01")).toBeInTheDocument();
    });
    expect(within(dialog).queryByText("Slack ticket")).not.toBeInTheDocument();

    click(findByFastRoleText("button", "Load more", dialog));
    await waitFor(() => {
      expect(within(dialog).getByText("Slack ticket")).toBeInTheDocument();
    });

    click(findByFastRoleText("button", "Today", dialog));
    await waitFor(() => {
      expect(findByFastRoleText("menuitem", "Last 7 days")).toBeInTheDocument();
    });
    click(findByFastRoleText("menuitem", "Last 7 days"));

    await waitFor(() => {
      expect(
        findByFastRoleText("button", "Last 7 days", dialog),
      ).toBeInTheDocument();
    });
  });

  it("shows team usage records for admins without the Members section", async () => {
    setMockOrg({ role: "admin" });
    setUsageRows([
      usageRow({
        title: "Team media chat",
        source: "chat",
        index: 2,
        memberEmail: "teammate@example.com",
      }),
    ]);

    const dialog = await openCreditBalanceSection();

    click(findByFastRoleText("tab", "Team usage", dialog));

    await waitFor(() => {
      expect(within(dialog).getByText("Team media chat")).toBeInTheDocument();
      expect(
        within(dialog).getByText("teammate@example.com"),
      ).toBeInTheDocument();
    });
    expect(within(dialog).getByText("Billing period")).toBeInTheDocument();
    expect(within(dialog).queryByText("Members")).not.toBeInTheDocument();
  });
});

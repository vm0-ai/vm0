import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type {
  UsageRecordResponse,
  UsageRecordRow,
  UsageRecordSource,
} from "@vm0/api-contracts/contracts/zero-usage-record";

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
    lastActivityAt: `2026-03-${args.index.toString().padStart(2, "0")}T12:00:00.000Z`,
  };
}

function setUsageRows(rows: UsageRecordRow[]): void {
  const response: UsageRecordResponse = {
    rows,
    pagination: { page: 1, pageSize: 20, total: rows.length },
  };
  setMockUsageRecord(response);
}

async function openCreditBalanceSection(): Promise<HTMLElement> {
  detachedSetupPage({ context, path: "/" });
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
  it("opens personal usage for non-admin members without team controls", async () => {
    setMockOrg({ role: "member" });
    setUsageRows([
      usageRow({ title: "Member chat", source: "chat", index: 1 }),
    ]);

    const dialog = await openCreditBalanceSection();

    await waitFor(() => {
      expect(within(dialog).getByText("Member chat")).toBeInTheDocument();
    });
    expect(within(dialog).getByText("All sources")).toBeInTheDocument();
    expect(within(dialog).queryByText("Team usage")).not.toBeInTheDocument();
  });

  it("loads additional personal rows and filters by source", async () => {
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

    click(findByFastRoleText("button", /All sources/i, dialog));
    await waitFor(() => {
      expect(findByFastRoleText("menuitem", "Slack")).toBeInTheDocument();
    });
    click(findByFastRoleText("menuitem", "Slack"));

    await waitFor(() => {
      expect(within(dialog).getByText("Slack ticket")).toBeInTheDocument();
      expect(within(dialog).queryByText("Chat 01")).not.toBeInTheDocument();
    });
  });
});

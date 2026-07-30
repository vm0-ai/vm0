import { zeroBillingInvoicesContract } from "@vm0/api-contracts/contracts/zero-billing";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { unixSecondsFromIso } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { i18n } from "../../../i18n/index.ts";

const context = testContext();

afterEach(async () => {
  await i18n.changeLanguage("en-US");
  document.documentElement.lang = "en-US";
});

function buttonByText(text: string): HTMLElement {
  const element = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/gu, " ").trim() === text;
  });
  if (!element) {
    throw new Error(`Button with text "${text}" not found`);
  }
  return element;
}

function selectOptionByText(text: string): HTMLElement {
  const option = screen.getAllByText(text).find((candidate) => {
    return candidate.closest('[role="option"]') !== null;
  });
  if (!option) {
    throw new Error(`Select option with text "${text}" not found`);
  }
  return option;
}

function mockInvoicesStory(): void {
  context.mocks.data.org({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
  context.mocks.api(zeroBillingInvoicesContract.get, ({ respond }) => {
    return respond(200, {
      receiptDownloadsSupported: true,
      invoices: [
        {
          id: "in_2026_0001",
          number: "INV-2026-0001",
          date: unixSecondsFromIso("2026-03-15T00:00:00.000Z"),
          amount: 2000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test",
        },
        {
          id: "in_2026_0002",
          number: "INV-2026-0002",
          date: unixSecondsFromIso("2026-03-01T00:00:00.000Z"),
          amount: 1000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test-2",
        },
        {
          id: "in_2026_0003",
          number: "INV-2026-0003",
          date: unixSecondsFromIso("2026-02-15T00:00:00.000Z"),
          amount: 3000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test-3",
        },
        {
          id: "in_2025_0004",
          number: "INV-2025-0004",
          date: unixSecondsFromIso("2025-12-15T00:00:00.000Z"),
          amount: 4000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test-4",
        },
      ],
    });
  });
}

async function openInvoicesTab(): Promise<void> {
  detachedSetupPage({ context, path: "/?settings=invoices" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Invoices" }),
    ).toBeInTheDocument();
  });
}

describe("organization invoices settings", () => {
  it("shows invoice row skeletons while history loads", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    const invoicesReady = context.mocks.deferred<void>();
    context.mocks.api(zeroBillingInvoicesContract.get, async ({ respond }) => {
      await invoicesReady.promise;
      return respond(200, { invoices: [] });
    });

    try {
      await openInvoicesTab();

      await expect(
        screen.findByTestId("invoice-list-skeleton"),
      ).resolves.toBeInTheDocument();

      invoicesReady.resolve();
      await waitFor(() => {
        expect(
          screen.queryByTestId("invoice-list-skeleton"),
        ).not.toBeInTheDocument();
        expect(screen.getByText("No invoices yet.")).toBeInTheDocument();
      });
    } finally {
      if (!invoicesReady.settled()) {
        invoicesReady.resolve();
      }
    }
  });

  it("localizes invoice presentation while preserving provider values", async () => {
    mockInvoicesStory();
    context.mocks.data.userPreferences({ locale: "pt-BR" });

    detachedSetupPage({
      context,
      path: "/?settings=invoices",
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
      },
    });

    const date = new Date(
      unixSecondsFromIso("2026-03-15T00:00:00.000Z") * 1000,
    ).toLocaleDateString("pt-BR");

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("pt-BR");
      expect(screen.getByText("Fatura")).toBeInTheDocument();
      expect(screen.getByText("Data")).toBeInTheDocument();
      expect(screen.getByText("Valor")).toBeInTheDocument();
      expect(screen.getByText("INV-2026-0001")).toBeInTheDocument();
      expect(screen.getAllByText("Paid").length).toBeGreaterThan(0);
      expect(screen.getByText(/US\$\s+20,00/u)).toBeInTheDocument();
      expect(screen.getByText(date)).toBeInTheDocument();
    });
  });

  it("formats invoice dates and amounts for German", async () => {
    mockInvoicesStory();
    context.mocks.data.userPreferences({ locale: "de-DE" });

    detachedSetupPage({
      context,
      path: "/?settings=invoices",
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
      },
    });

    const date = new Date(
      unixSecondsFromIso("2026-03-15T00:00:00.000Z") * 1000,
    ).toLocaleDateString("de-DE");

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("de-DE");
      expect(screen.getByText("Rechnung")).toBeInTheDocument();
      expect(screen.getByText("Datum")).toBeInTheDocument();
      expect(screen.getByText("Betrag")).toBeInTheDocument();
      expect(screen.getAllByText("Paid").length).toBeGreaterThan(0);
      expect(screen.getByText(/20,00\s+\$/u)).toBeInTheDocument();
      expect(screen.getByText(date)).toBeInTheDocument();
    });
  });

  it("hides ZIP downloads while an older API deployment is active", async () => {
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingInvoicesContract.get, ({ respond }) => {
      return respond(200, {
        invoices: [
          {
            id: "in_legacy",
            number: "INV-LEGACY",
            date: unixSecondsFromIso("2026-03-15T00:00:00.000Z"),
            amount: 2000,
            status: "paid",
            hostedInvoiceUrl: "https://billing.stripe.com/invoice/legacy",
          },
        ],
      });
    });

    await openInvoicesTab();

    expect(
      queryAllByRoleFast("button").some((button) => {
        return button.textContent?.includes("Download receipts") === true;
      }),
    ).toBeFalsy();
  });

  it("downloads all receipts for a selected month as a ZIP", async () => {
    const user = userEvent.setup();
    const browserDownload = context.mocks.browser.blobDownload();
    let requestedRange: {
      readonly startMonth: string;
      readonly endMonth: string;
    } | null = null;
    const receiptsReady = context.mocks.deferred<void>();
    mockInvoicesStory();
    context.mocks.api(
      zeroBillingInvoicesContract.downloadReceipts,
      async ({ query, respond }) => {
        requestedRange = query;
        await receiptsReady.promise;
        return respond(
          200,
          new Blob(["monthly receipts"], { type: "application/zip" }),
        );
      },
    );
    try {
      await openInvoicesTab();

      await waitFor(() => {
        expect(screen.getByText("INV-2026-0001")).toBeInTheDocument();
        expect(screen.getAllByText("Paid")).toHaveLength(4);
        expect(screen.getByText("3/15/2026")).toBeInTheDocument();
        expect(screen.getByText("$20.00")).toBeInTheDocument();
      });
      expect(
        screen.getAllByLabelText("Download March 2026 invoice")[0],
      ).toHaveAttribute("href", "https://billing.stripe.com/invoice/test");

      await user.click(buttonByText("Download receipts"));
      expect(
        screen.getByRole("heading", { name: "Download receipts" }),
      ).toBeInTheDocument();
      await user.click(screen.getByLabelText("From month"));
      await user.click(selectOptionByText("December 2025"));
      expect(
        screen.getByText(
          "Select a range of no more than 3 consecutive months.",
        ),
      ).toBeInTheDocument();
      expect(buttonByText("Download ZIP")).toBeDisabled();

      await user.click(screen.getByLabelText("From month"));
      await user.click(selectOptionByText("February 2026"));
      expect(buttonByText("Download ZIP")).not.toBeDisabled();
      await user.click(buttonByText("Download ZIP"));

      await expect(
        screen.findByText("Preparing receipt download..."),
      ).resolves.toBeInTheDocument();
      receiptsReady.resolve();
      await waitFor(() => {
        expect(requestedRange).toStrictEqual({
          startMonth: "2026-02",
          endMonth: "2026-03",
        });
        expect(browserDownload.downloads).toHaveLength(1);
        expect(screen.getByText("Receipts downloaded")).toBeInTheDocument();
      });
      expect(browserDownload.downloads[0]?.filename).toBe(
        "receipts-2026-02-to-2026-03.zip",
      );
    } finally {
      if (!receiptsReady.settled()) {
        receiptsReady.resolve();
      }
    }
  });

  it("shows an error toast when receipt download fails", async () => {
    const user = userEvent.setup();
    mockInvoicesStory();
    context.mocks.api(
      zeroBillingInvoicesContract.downloadReceipts,
      ({ respond }) => {
        return respond(502, {
          error: {
            code: "BAD_GATEWAY",
            message: "Failed to download receipts from Stripe",
          },
        });
      },
    );
    await openInvoicesTab();

    await user.click(buttonByText("Download receipts"));
    await user.click(buttonByText("Download ZIP"));

    await expect(
      screen.findByText("Failed to download receipts"),
    ).resolves.toBeInTheDocument();
  });
});

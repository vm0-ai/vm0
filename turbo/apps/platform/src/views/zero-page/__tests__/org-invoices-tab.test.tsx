import { zeroBillingInvoicesContract } from "@vm0/api-contracts/contracts/zero-billing";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { unixSecondsFromIso } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockInvoicesStory(invoicePdfUrl?: string): void {
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
          id: "in_2026_0001",
          number: "INV-2026-0001",
          date: unixSecondsFromIso("2026-03-15T00:00:00.000Z"),
          amount: 2000,
          status: "paid",
          hostedInvoiceUrl: "https://billing.stripe.com/invoice/test",
          invoicePdfUrl,
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

  it("downloads the PDF for an invoice month", async () => {
    mockInvoicesStory("https://billing.stripe.com/invoice.pdf");
    await openInvoicesTab();

    await waitFor(() => {
      expect(screen.getByText("INV-2026-0001")).toBeInTheDocument();
      expect(screen.getByText("Paid")).toBeInTheDocument();
      expect(screen.getByText("3/15/2026")).toBeInTheDocument();
      expect(screen.getByText("$20.00")).toBeInTheDocument();
    });
    const downloadLink = screen.getByLabelText("Download March 2026 invoice");
    expect(downloadLink).toHaveAttribute(
      "href",
      "https://billing.stripe.com/invoice.pdf",
    );
    expect(downloadLink).toHaveAttribute("download", "invoice-2026-03.pdf");
  });

  it("keeps the hosted invoice link when the API omits the PDF URL", async () => {
    mockInvoicesStory();
    await openInvoicesTab();

    const downloadLink = await screen.findByLabelText(
      "Download March 2026 invoice",
    );
    expect(downloadLink).toHaveAttribute(
      "href",
      "https://billing.stripe.com/invoice/test",
    );
    expect(downloadLink).not.toHaveAttribute("download");
  });
});

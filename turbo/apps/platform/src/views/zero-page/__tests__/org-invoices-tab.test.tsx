import { zeroBillingInvoicesContract } from "@vm0/api-contracts/contracts/zero-billing";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { unixSecondsFromIso } from "../../../__tests__/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

function mockInvoicesStory(): void {
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
  it("shows invoice history with a download link", async () => {
    mockInvoicesStory();
    await openInvoicesTab();

    await waitFor(() => {
      expect(screen.getByText("INV-2026-0001")).toBeInTheDocument();
      expect(screen.getByText("Paid")).toBeInTheDocument();
      expect(screen.getByText("3/15/2026")).toBeInTheDocument();
      expect(screen.getByText("$20.00")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Download invoice")).toHaveAttribute(
      "href",
      "https://billing.stripe.com/invoice/test",
    );
  });
});

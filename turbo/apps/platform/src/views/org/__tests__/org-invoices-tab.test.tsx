import { describe, it, expect, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import {
  setMockBillingInvoices,
  resetMockBilling,
} from "../../../mocks/handlers/api-billing.ts";
import { setMockOrg, resetMockOrg } from "../../../mocks/handlers/api-org.ts";
import { zeroBillingInvoicesContract } from "@vm0/core/contracts/zero-billing";
import { createMockApi } from "../../../mocks/msw-contract.ts";

const context = testContext();
const mockApi = createMockApi(context);

interface InvoiceOverrides {
  id?: string;
  number?: string | null;
  date?: number;
  amount?: number;
  status?: string | null;
  hostedInvoiceUrl?: string | null;
}

function makeInvoice(overrides?: InvoiceOverrides) {
  return {
    id: overrides?.id ?? "inv_001",
    number: overrides?.number !== undefined ? overrides.number : "INV-001",
    date: overrides?.date ?? 1_700_000_000,
    amount: overrides?.amount ?? 4999,
    status: overrides?.status !== undefined ? overrides.status : "paid",
    hostedInvoiceUrl:
      overrides?.hostedInvoiceUrl !== undefined
        ? overrides.hostedInvoiceUrl
        : "https://invoice.stripe.com/inv_001",
  };
}

beforeEach(() => {
  resetMockOrg();
  resetMockBilling();
  setMockOrg({
    id: "org_1",
    slug: "test-org",
    name: "Test Org",
    role: "admin",
  });
});

async function openInvoicesTab() {
  detachedSetupPage({ context, path: "/?settings=invoices" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

// ORG-D-059
describe("invoice list display", () => {
  it("shows invoice number, date, amount, and status badge", async () => {
    setMockBillingInvoices([
      makeInvoice({ number: "INV-001", amount: 4999, status: "paid" }),
    ]);
    await openInvoicesTab();
    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeInTheDocument();
    });
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("$49.99")).toBeInTheDocument();
  });

  it("shows invoice id when number is null", async () => {
    setMockBillingInvoices([makeInvoice({ id: "inv_abc123", number: null })]);
    await openInvoicesTab();
    await waitFor(() => {
      expect(screen.getByText("inv_abc123")).toBeInTheDocument();
    });
  });
});

// ORG-D-060
it("formats date and amount correctly", async () => {
  const timestamp = 1_700_000_000;
  const expectedDate = new Date(timestamp * 1000).toLocaleDateString("en-US");
  setMockBillingInvoices([makeInvoice({ date: timestamp, amount: 12_050 })]);
  await openInvoicesTab();
  await waitFor(() => {
    expect(screen.getByText(expectedDate)).toBeInTheDocument();
  });
  expect(screen.getByText("$120.50")).toBeInTheDocument();
});

// ORG-C-061
it("shows download link only when hostedInvoiceUrl is available", async () => {
  setMockBillingInvoices([
    makeInvoice({
      id: "inv_1",
      number: "INV-001",
      hostedInvoiceUrl: "https://invoice.stripe.com/inv_1",
    }),
    makeInvoice({
      id: "inv_2",
      number: "INV-002",
      hostedInvoiceUrl: null,
    }),
  ]);
  await openInvoicesTab();
  await waitFor(() => {
    expect(screen.getByText("INV-001")).toBeInTheDocument();
  });
  const downloadLinks = screen.getAllByRole("link").filter((el) => {
    return /Download invoice/.test(el.getAttribute("aria-label") ?? "");
  });
  expect(downloadLinks).toHaveLength(1);
  expect(downloadLinks[0]).toHaveAttribute(
    "href",
    "https://invoice.stripe.com/inv_1",
  );
});

// ORG-C-062
it("shows empty state when no invoices exist", async () => {
  // Default handler already returns empty invoices, just open the tab
  await openInvoicesTab();
  await waitFor(() => {
    expect(screen.getByText("No invoices yet.")).toBeInTheDocument();
  });
});

// ORG-D-063
it("shows loading state while invoices load", async () => {
  const invoicesDeferred = createDeferredPromise<void>(context.signal);
  server.use(
    mockApi(zeroBillingInvoicesContract.get, async ({ respond }) => {
      await invoicesDeferred.promise;
      return respond(200, { invoices: [] });
    }),
  );
  await openInvoicesTab();
  await waitFor(() => {
    expect(screen.getByText("Loading invoices...")).toBeInTheDocument();
  });
  invoicesDeferred.resolve();
  await waitFor(() => {
    expect(screen.getByText("No invoices yet.")).toBeInTheDocument();
  });
});

// ORG-I-064
it("shows tooltip when hovering download link", async () => {
  const user = userEvent.setup();
  setMockBillingInvoices([
    makeInvoice({ hostedInvoiceUrl: "https://invoice.stripe.com/inv_1" }),
  ]);
  await openInvoicesTab();
  await waitFor(() => {
    expect(
      screen.getAllByRole("link").some((el) => {
        return /Download invoice/.test(el.getAttribute("aria-label") ?? "");
      }),
    ).toBeTruthy();
  });
  const downloadLink = screen.getAllByRole("link").find((el) => {
    return /Download invoice/.test(el.getAttribute("aria-label") ?? "");
  });
  if (!downloadLink) {
    throw new Error("Download link not found");
  }
  await user.hover(downloadLink);
  await waitFor(() => {
    expect(
      screen.getAllByText("Download invoice").length,
    ).toBeGreaterThanOrEqual(2);
  });
});

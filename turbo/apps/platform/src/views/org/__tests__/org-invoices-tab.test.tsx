import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

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

function mockAPIs() {
  server.use(
    http.get("*/api/zero/org", () => {
      return HttpResponse.json({
        id: "org_1",
        slug: "test-org",
        name: "Test Org",
        role: "admin",
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          name: "zero",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/org/logo", () => {
      return HttpResponse.json({ logoUrl: null });
    }),
  );
}

async function openInvoicesTab() {
  detachedSetupPage({ context, path: "/?settings=invoices" });
  await waitFor(() => {
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
}

// ORG-D-059
describe("invoice list display", () => {
  it("shows invoice number, date, amount, and status badge", async () => {
    mockAPIs();
    server.use(
      http.get("*/api/zero/billing/invoices", () => {
        return HttpResponse.json({
          invoices: [
            makeInvoice({ number: "INV-001", amount: 4999, status: "paid" }),
          ],
        });
      }),
    );
    await openInvoicesTab();
    await waitFor(() => {
      expect(screen.getByText("INV-001")).toBeInTheDocument();
    });
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("$49.99")).toBeInTheDocument();
  });

  it("shows invoice id when number is null", async () => {
    mockAPIs();
    server.use(
      http.get("*/api/zero/billing/invoices", () => {
        return HttpResponse.json({
          invoices: [makeInvoice({ id: "inv_abc123", number: null })],
        });
      }),
    );
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
  mockAPIs();
  server.use(
    http.get("*/api/zero/billing/invoices", () => {
      return HttpResponse.json({
        invoices: [makeInvoice({ date: timestamp, amount: 12_050 })],
      });
    }),
  );
  await openInvoicesTab();
  await waitFor(() => {
    expect(screen.getByText(expectedDate)).toBeInTheDocument();
  });
  expect(screen.getByText("$120.50")).toBeInTheDocument();
});

// ORG-C-061
it("shows download link only when hostedInvoiceUrl is available", async () => {
  mockAPIs();
  server.use(
    http.get("*/api/zero/billing/invoices", () => {
      return HttpResponse.json({
        invoices: [
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
        ],
      });
    }),
  );
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
  mockAPIs();
  server.use(
    http.get("*/api/zero/billing/invoices", () => {
      return HttpResponse.json({ invoices: [] });
    }),
  );
  await openInvoicesTab();
  await waitFor(() => {
    expect(screen.getByText("No invoices yet.")).toBeInTheDocument();
  });
});

// ORG-D-063
it("shows loading state while invoices load", async () => {
  const deferred = createDeferredPromise<void>(context.signal);
  mockAPIs();
  server.use(
    http.get("*/api/zero/billing/invoices", async () => {
      await deferred.promise;
      return HttpResponse.json({ invoices: [] });
    }),
  );
  await openInvoicesTab();
  await waitFor(() => {
    expect(screen.getByText("Loading invoices...")).toBeInTheDocument();
  });
  deferred.resolve();
  await waitFor(() => {
    expect(screen.getByText("No invoices yet.")).toBeInTheDocument();
  });
});

// ORG-I-064
it("shows tooltip when hovering download link", async () => {
  const user = userEvent.setup();
  mockAPIs();
  server.use(
    http.get("*/api/zero/billing/invoices", () => {
      return HttpResponse.json({
        invoices: [
          makeInvoice({ hostedInvoiceUrl: "https://invoice.stripe.com/inv_1" }),
        ],
      });
    }),
  );
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

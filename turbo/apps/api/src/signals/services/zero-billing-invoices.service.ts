import { ZipArchive } from "archiver";
import { command, computed, type Computed } from "ccstate";
import type { BillingInvoicesResponse } from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { db$ } from "../external/db";
import { listStripeInvoices } from "../external/stripe-client";
import {
  createDeferredPromise,
  onRejection,
  safeSync,
  tapError,
} from "../utils";

interface ReceiptArchive {
  readonly filename: string;
  readonly content: Buffer;
}

type ReceiptArchiveResult =
  | { readonly kind: "ok"; readonly archive: ReceiptArchive }
  | { readonly kind: "not_found" }
  | { readonly kind: "upstream_error" };

interface ReceiptEntry {
  readonly path: string;
  readonly content: Buffer;
}

function monthlyRange(
  startMonth: string,
  endMonth: string,
): {
  readonly gte: number;
  readonly lt: number;
} {
  const startYear = Number(startMonth.slice(0, 4));
  const startMonthIndex = Number(startMonth.slice(5, 7)) - 1;
  const endYear = Number(endMonth.slice(0, 4));
  const endMonthIndex = Number(endMonth.slice(5, 7)) - 1;
  return {
    gte: Date.UTC(startYear, startMonthIndex, 1) / 1000,
    lt: Date.UTC(endYear, endMonthIndex + 1, 1) / 1000,
  };
}

function receiptFilename(invoiceNumber: string | null, id: string): string {
  const reference = (invoiceNumber ?? id).replace(/[^a-zA-Z0-9._-]+/gu, "-");
  return `receipt-${reference}.pdf`;
}

async function assembleReceiptArchive(
  entries: readonly ReceiptEntry[],
  signal: AbortSignal,
): Promise<Buffer> {
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const done = createDeferredPromise<Buffer>(signal);

  archive.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  archive.on("end", () => {
    if (!done.settled()) {
      done.resolve(Buffer.concat(chunks));
    }
  });
  archive.on("error", (error) => {
    if (!done.settled()) {
      done.reject(error);
    }
  });

  const appendResult = safeSync(() => {
    for (const entry of entries) {
      archive.append(entry.content, { name: entry.path });
    }
  });
  if ("error" in appendResult) {
    if (!done.settled()) {
      done.reject(appendResult.error);
    }
    return await done.promise;
  }

  const finalized = (async () => {
    await onRejection(archive.finalize(), (error) => {
      if (!done.settled()) {
        done.reject(error);
      }
    });
    signal.throwIfAborted();
    return await done.promise;
  })();
  return await Promise.race([done.promise, finalized]);
}

export function zeroOrgInvoices(
  orgId: string,
): Computed<Promise<BillingInvoicesResponse>> {
  return computed(async (get): Promise<BillingInvoicesResponse> => {
    const db = get(db$);

    const [row] = await db
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    if (!row?.stripeCustomerId) {
      return { invoices: [], receiptDownloadsSupported: true };
    }

    const result = await listStripeInvoices(row.stripeCustomerId);

    return {
      receiptDownloadsSupported: true,
      invoices: result.map((inv) => {
        return {
          id: inv.id,
          number: inv.number,
          date: inv.created,
          amount: inv.amount_paid,
          status: inv.status,
          hostedInvoiceUrl: inv.hosted_invoice_url,
        };
      }),
    };
  });
}

export const downloadZeroOrgReceiptArchive$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly startMonth: string;
      readonly endMonth: string;
    },
    signal: AbortSignal,
  ): Promise<ReceiptArchiveResult> => {
    const db = get(db$);
    const [row] = await db
      .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    signal.throwIfAborted();

    if (!row?.stripeCustomerId) {
      return { kind: "not_found" };
    }

    const invoices = await listStripeInvoices(
      row.stripeCustomerId,
      monthlyRange(args.startMonth, args.endMonth),
    );
    signal.throwIfAborted();
    const receipts = invoices.filter((invoice) => {
      return invoice.invoice_pdf !== null;
    });
    if (receipts.length === 0) {
      return { kind: "not_found" };
    }

    const downloaded = await Promise.all(
      receipts.map(async (invoice) => {
        const url = invoice.invoice_pdf;
        if (!url) {
          return null;
        }
        const response = await tapError(fetch(url, { signal }));
        signal.throwIfAborted();
        if (!response?.ok) {
          return null;
        }
        return {
          path: receiptFilename(invoice.number, invoice.id),
          content: Buffer.from(await response.arrayBuffer()),
        };
      }),
    );
    signal.throwIfAborted();
    if (
      downloaded.some((entry) => {
        return entry === null;
      })
    ) {
      return { kind: "upstream_error" };
    }
    const entries = downloaded.filter((entry) => {
      return entry !== null;
    });

    return {
      kind: "ok",
      archive: {
        filename:
          args.startMonth === args.endMonth
            ? `receipts-${args.startMonth}.zip`
            : `receipts-${args.startMonth}-to-${args.endMonth}.zip`,
        content: await assembleReceiptArchive(entries, signal),
      },
    };
  },
);

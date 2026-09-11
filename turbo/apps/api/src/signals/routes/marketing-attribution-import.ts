import { timingSafeEqual } from "node:crypto";
import { command } from "ccstate";
import { and, asc, eq, gt } from "drizzle-orm";
import { marketingAttributionImportContract } from "@okouai/api-contracts/contracts/marketing-attribution-import";
import { importedAttribution } from "@okouai/db/operations/user-attribution-import";
import {
  userAttributionImports,
  userAcquisitionDeliveryImports,
} from "@okouai/db/schema/user-attribution";
import { optionalEnv } from "../../lib/env";
import { notConfigured } from "../../lib/error";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";

const inspect$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = optionalEnv("MARKETING_ATTRIBUTION_API_SECRET");
  if (!secret) {
    return notConfigured("Marketing attribution inspection is unavailable");
  }
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(get(authorization$) ?? "");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return {
      status: 401 as const,
      body: {
        error: {
          code: "UNAUTHORIZED",
          message: "Marketing attribution operator authentication is required",
        },
      },
    };
  }
  const body = await get(
    bodyResultOf(marketingAttributionImportContract.inspect),
  );
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = get(db$);
  const [row] = await db
    .select()
    .from(userAttributionImports)
    .where(eq(userAttributionImports.userId, body.data.userId));
  signal.throwIfAborted();
  const deliveries = await db
    .select()
    .from(userAcquisitionDeliveryImports)
    .where(
      and(
        eq(userAcquisitionDeliveryImports.userId, body.data.userId),
        body.data.afterTransactionId === undefined
          ? undefined
          : gt(
              userAcquisitionDeliveryImports.transactionId,
              body.data.afterTransactionId,
            ),
      ),
    )
    .orderBy(asc(userAcquisitionDeliveryImports.transactionId))
    .limit(101);
  signal.throwIfAborted();
  const page = deliveries.slice(0, 100);
  return {
    status: 200 as const,
    body: {
      state: row?.state ?? "not_imported",
      sourceUpdatedAt: row?.sourceUpdatedAt.toISOString() ?? null,
      attribution:
        row?.state === "captured" ? importedAttribution(row.firstTouch) : null,
      privacyReceipt:
        row?.state === "captured" &&
        typeof row.firstTouch.privacyReceipt === "string"
          ? row.firstTouch.privacyReceipt
          : null,
      deliveries: page.map((delivery) => {
        return {
          transactionId: delivery.transactionId,
          latest: delivery.latest.value,
          accepted: delivery.accepted?.value ?? null,
          conflict: delivery.conflict,
        };
      }),
      nextTransactionId:
        deliveries.length > 100 ? (page.at(-1)?.transactionId ?? null) : null,
    },
  };
});

export const marketingAttributionImportRoutes: readonly RouteEntry[] = [
  { route: marketingAttributionImportContract.inspect, handler: inspect$ },
];

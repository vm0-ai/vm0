import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { marketingAttributionImportContract } from "@okouai/api-contracts/contracts/marketing-attribution-import";
import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { marketingAttributionImportRoutes } from "../marketing-attribution-import";
import { webhooksClerkRoutes } from "../webhooks-clerk";

const context = testContext();
const SECRET = "test-attribution-import-secret-at-least-32-characters";
const OPERATOR = Object.freeze({ authorization: `Bearer ${SECRET}` });
const TOUCH = Object.freeze({
  gclid: "original-click",
  vm0_campaign_id: "24220469665",
  recorded_at: "2026-09-09T12:00:00.000Z",
});
const T0 = Date.parse(TOUCH.recorded_at);

function client() {
  return setupApp({ context, routes: marketingAttributionImportRoutes })(
    marketingAttributionImportContract,
  );
}
async function inspect(userId: string, afterTransactionId?: string) {
  return (
    await accept(
      client().inspect({
        headers: OPERATOR,
        body: { userId, afterTransactionId },
      }),
      [200],
    )
  ).body;
}
function event(type: string, data: unknown, status: 200 | 503 = 200) {
  context.mocks.clerk.verifyWebhook.mockResolvedValueOnce({ type, data });
  return accept(
    setupApp({ context, routes: webhooksClerkRoutes })(
      webhookClerkContract,
    ).post({ body: "{}" }),
    [status],
  );
}
function update(
  userId: string,
  metadata: Record<string, unknown>,
  version = T0,
) {
  return event("user.updated", {
    id: userId,
    updated_at: version,
    private_metadata: metadata,
  });
}
beforeEach(() => {
  mockOptionalEnv("MARKETING_ATTRIBUTION_API_SECRET", SECRET);
  mockOptionalEnv("CLERK_WEBHOOK_SIGNING_SECRET", "whsec_import_test");
});

describe("Clerk attribution import bridge", () => {
  it("requires dedicated operator credentials before inspecting any user", async () => {
    const body = { userId: `user_${randomUUID()}` };
    await accept(client().inspect({ body }), [401]);
    await accept(
      client().inspect({
        headers: { authorization: "Bearer clerk-session" },
        body,
      }),
      [401],
    );
    const response = await accept(
      client().inspect({ headers: OPERATOR, body }),
      [200],
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.body.state).toBe("not_imported");
    mockOptionalEnv("MARKETING_ATTRIBUTION_API_SECRET", undefined);
    await accept(client().inspect({ headers: OPERATOR, body }), [503]);
  });

  it("imports an absent user and later first capture without a Clerk directory call", async () => {
    const id = `user_${randomUUID()}`;
    await event("user.created", { id, updated_at: T0, private_metadata: {} });
    expect((await inspect(id)).state).toBe("absent");
    await update(
      id,
      {
        signup_attribution: TOUCH,
        marketing_privacy_receipt: "existing-receipt",
      },
      T0 + 1,
    );
    const imported = await inspect(id);
    expect(imported.state).toBe("captured");
    expect(imported.attribution).toMatchObject({
      gclid: "original-click",
      okou_campaign_id: "24220469665",
    });
    expect(imported.privacyReceipt).toBe("existing-receipt");
    expect(context.mocks.clerk.users.getUserList).not.toHaveBeenCalled();
  });

  it("keeps organic and malformed saved touches distinct from absence", async () => {
    const organic = `user_${randomUUID()}`;
    const malformed = `user_${randomUUID()}`;
    await update(organic, {
      signup_attribution: { source_type: "organic_search" },
    });
    await update(malformed, { signup_attribution: "broken legacy touch" });
    expect((await inspect(organic)).state).toBe("captured");
    await expect(inspect(malformed)).resolves.toMatchObject({
      state: "invalid",
      attribution: null,
    });
    await update(malformed, { signup_attribution: TOUCH }, T0 + 1);
    await expect(inspect(malformed)).resolves.toMatchObject({
      state: "conflict",
      attribution: null,
    });
  });

  it("deduplicates retries and keeps newer state when an absent creation event arrives late", async () => {
    const id = `user_${randomUUID()}`;
    const metadata = { signup_attribution: TOUCH };
    await update(id, metadata, T0 + 1);
    const before = await inspect(id);
    await update(id, metadata, T0 + 1);
    await update(id, {}, T0);
    await expect(inspect(id)).resolves.toStrictEqual(before);
  });

  it("records a conflicting first touch instead of silently changing campaign ownership", async () => {
    const id = `user_${randomUUID()}`;
    await update(id, { signup_attribution: TOUCH });
    await update(
      id,
      {
        signup_attribution: {
          ...TOUCH,
          vm0_campaign_id: "24154967178",
          gclid: "later-click",
        },
      },
      T0 + 1,
    );
    await expect(inspect(id)).resolves.toMatchObject({
      state: "conflict",
      attribution: null,
      privacyReceipt: null,
    });
  });

  it("preserves accepted delivery after a failed attempt and imports late historical receipts", async () => {
    const id = `user_${randomUUID()}`;
    const accepted = {
      status: "submitted",
      kind: "first_run_completed",
      request_id: "accepted-request",
      operating_account_id: "7935750692",
      attribution: TOUCH,
    };
    await update(id, {
      signup_attribution: TOUCH,
      google_data_manager_acquisition_conversions: { txn: accepted },
    });
    await update(
      id,
      {
        signup_attribution: TOUCH,
        google_data_manager_acquisition_conversions: {
          txn: { status: "failed" },
        },
      },
      T0 + 1,
    );
    await update(
      id,
      {
        signup_attribution: TOUCH,
        google_data_manager_acquisition_conversions: {
          old: { status: "uploaded", event_time: TOUCH.recorded_at },
        },
      },
      T0 - 1,
    );
    const result = await inspect(id);
    expect(result.deliveries).toStrictEqual([
      {
        transactionId: "old",
        latest: { status: "uploaded", event_time: TOUCH.recorded_at },
        accepted: { status: "uploaded", event_time: TOUCH.recorded_at },
        conflict: false,
      },
      {
        transactionId: "txn",
        latest: { status: "failed" },
        accepted,
        conflict: false,
      },
    ]);
  });

  it("holds equal-version conflicting receipts for reconciliation", async () => {
    const id = `user_${randomUUID()}`;
    await update(id, {
      google_data_manager_acquisition_conversions: {
        txn: { status: "pending_account" },
      },
    });
    await update(id, {
      google_data_manager_acquisition_conversions: {
        txn: { status: "submitted", request_id: "receipt" },
      },
    });
    expect((await inspect(id)).deliveries).toStrictEqual([
      {
        transactionId: "txn",
        latest: { status: "pending_account" },
        accepted: { status: "submitted", request_id: "receipt" },
        conflict: true,
      },
    ]);
  });

  it("serializes concurrent deliveries without dropping either transaction", async () => {
    const id = `user_${randomUUID()}`;
    await Promise.all([
      update(id, {
        signup_attribution: TOUCH,
        google_data_manager_acquisition_conversions: {
          first: { status: "submitted" },
        },
      }),
      update(
        id,
        {
          signup_attribution: TOUCH,
          google_data_manager_acquisition_conversions: {
            second: { status: "submitted" },
          },
        },
        T0 + 1,
      ),
    ]);
    expect(
      (await inspect(id)).deliveries.map((row) => {
        return row.transactionId;
      }),
    ).toStrictEqual(["first", "second"]);
  });

  it("bounds delivery inspection and supports a stable transaction cursor", async () => {
    const id = `user_${randomUUID()}`;
    const deliveries = Object.fromEntries(
      Array.from({ length: 102 }, (_, i) => {
        return [
          `txn-${String(i).padStart(3, "0")}`,
          { status: "pending_account" },
        ];
      }),
    );
    await update(id, {
      google_data_manager_acquisition_conversions: deliveries,
    });
    const first = await inspect(id);
    expect(first.deliveries).toHaveLength(100);
    expect(first.nextTransactionId).toBe("txn-099");
    const second = await inspect(id, first.nextTransactionId ?? undefined);
    expect(
      second.deliveries.map((row) => {
        return row.transactionId;
      }),
    ).toStrictEqual(["txn-100", "txn-101"]);
    expect(second.nextTransactionId).toBeNull();
  });

  it("rejects incomplete snapshots so provider retries cannot record false absence", async () => {
    const id = `user_${randomUUID()}`;
    await event("user.updated", { id, updated_at: T0 }, 503);
    expect((await inspect(id)).state).toBe("not_imported");
    await event("user.updated", { id, private_metadata: {} }, 503);
    expect((await inspect(id)).state).toBe("not_imported");
  });

  it("quarantines a malformed delivery map without pretending no deliveries exist", async () => {
    const id = `user_${randomUUID()}`;
    await update(id, {
      signup_attribution: TOUCH,
      google_data_manager_acquisition_conversions: "malformed history",
    });
    await expect(inspect(id)).resolves.toMatchObject({
      state: "conflict",
      attribution: null,
    });
  });

  it("erases imported evidence on deletion and rejects delayed resurrection", async () => {
    const id = `user_${randomUUID()}`;
    await update(id, {
      signup_attribution: TOUCH,
      google_data_manager_acquisition_conversions: {
        txn: { status: "submitted" },
      },
    });
    await event("user.deleted", { id });
    await update(id, { signup_attribution: TOUCH }, T0 + 10);
    await expect(inspect(id)).resolves.toMatchObject({
      state: "deleted",
      attribution: null,
      privacyReceipt: null,
      deliveries: [],
    });
  });
});

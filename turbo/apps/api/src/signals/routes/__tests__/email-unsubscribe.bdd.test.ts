import { randomUUID } from "node:crypto";

import { emailUnsubscribeContract } from "@vm0/api-contracts/contracts/email-unsubscribe";
import { users } from "@vm0/db/schema/user";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

// BDD migration of the legacy `email-unsubscribe.test.ts`. The
// 12 legacy `it()`s collapse into 2 BDD `it()`s: (1) GET chain
// (400 missing token → 400 invalid token → 400 non-hex signature
// → 200 unsubscribes existing user + HTML → 200 idempotent on
// repeat → 200 creates user row when missing), (2) POST chain
// (400 missing token → 400 invalid token → 400 non-hex signature
// → 200 unsubscribes existing user → 200 idempotent on repeat →
// 200 creates user row when missing).
//
// Service-Level Exception: `users` rows are seeded directly via
// `writeDb$` because no public route creates one with a known
// `id`; post-unsubscribe state is verified via direct DB reads.

const context = testContext();
const store = createStore();
const ROUTE = "/api/email/unsubscribe";

async function createToken(userId: string): Promise<string> {
  const textEncoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(env("SECRETS_ENCRYPTION_KEY")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(`unsubscribe:${userId}`),
  );
  const hmac = Buffer.from(signature).toString("hex").slice(0, 32);
  return `${userId}.${hmac}`;
}

async function insertUser(userId: string): Promise<void> {
  await store
    .set(writeDb$)
    .insert(users)
    .values({ id: userId, emailUnsubscribed: false });
}

async function findUser(
  userId: string,
): Promise<{ readonly emailUnsubscribed: boolean } | undefined> {
  const [row] = await store
    .set(writeDb$)
    .select({ emailUnsubscribed: users.emailUnsubscribed })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row;
}

function requestGetUnsubscribe(token?: string): Promise<Response> {
  const search =
    token === undefined ? "" : `?token=${encodeURIComponent(token)}`;
  const app = createApp({ signal: context.signal });
  return Promise.resolve(app.request(`${ROUTE}${search}`, { method: "GET" }));
}

function client() {
  return setupApp({ context })(emailUnsubscribeContract);
}

describe("BDD GET /api/email/unsubscribe — full chain", () => {
  const trackUser = createFixtureTracker<string>(async (userId) => {
    await store.set(writeDb$).delete(users).where(eq(users.id, userId));
  });

  it("gwt-wt-wt: 400 missing token → 400 invalid token → 400 non-hex signature → 200 unsubscribes existing user with HTML → 200 idempotent on repeat → 200 creates user row when missing", async () => {
    // When + Then: 400 when no token is provided.
    const missing = await requestGetUnsubscribe();
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toStrictEqual({
      error: "Missing token",
    });

    // When + Then: 400 on malformed token.
    const bad = await requestGetUnsubscribe("bad.token");
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toStrictEqual({ error: "Invalid token" });

    // When + Then: 400 when signature is not hex.
    const nonHex = await requestGetUnsubscribe(
      `user_${randomUUID()}.${"é".repeat(32)}`,
    );
    expect(nonHex.status).toBe(400);
    await expect(nonHex.json()).resolves.toStrictEqual({
      error: "Invalid token",
    });

    // Given: an existing user.
    const userId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(userId));
    await insertUser(userId);
    const token = await createToken(userId);

    // When: GET with a valid token.
    const first = await requestGetUnsubscribe(token);

    // Then: 200 with the HTML confirmation + the row is
    // unsubscribed.
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/html");
    const html = await first.text();
    expect(html).toContain("You have been unsubscribed");
    expect(html).toContain("http://localhost:3002/settings");
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });

    // When + Then: the same token is idempotent.
    const second = await requestGetUnsubscribe(token);
    expect(second.status).toBe(200);
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });

    // Given: a token for a user that does not exist.
    const freshUserId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(freshUserId));
    const freshToken = await createToken(freshUserId);

    // When + Then: the user row is created with
    // emailUnsubscribed = true.
    const created = await requestGetUnsubscribe(freshToken);
    expect(created.status).toBe(200);
    await expect(findUser(freshUserId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });
  });
});

describe("BDD POST /api/email/unsubscribe — full chain", () => {
  const trackUser = createFixtureTracker<string>(async (userId) => {
    await store.set(writeDb$).delete(users).where(eq(users.id, userId));
  });

  it("gwt-wt-wt: 400 missing token → 400 invalid token → 400 non-hex signature → 200 unsubscribes existing user → 200 idempotent on repeat → 200 creates user row when missing", async () => {
    const c = client();

    // When + Then: 400 when no token is provided.
    const missing = await accept(c.unsubscribe({ query: {} }), [400]);
    expect(missing.body).toStrictEqual({ error: "Missing token" });

    // When + Then: 400 on malformed token.
    const bad = await accept(
      c.unsubscribe({ query: { token: "bad.token" } }),
      [400],
    );
    expect(bad.body).toStrictEqual({ error: "Invalid token" });

    // When + Then: 400 when signature is not hex.
    const nonHex = await accept(
      c.unsubscribe({
        query: { token: `user_${randomUUID()}.${"é".repeat(32)}` },
      }),
      [400],
    );
    expect(nonHex.body).toStrictEqual({ error: "Invalid token" });

    // Given: an existing user.
    const userId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(userId));
    await insertUser(userId);
    const token = await createToken(userId);

    // When + Then: 200 with `{ unsubscribed: true }` and the
    // row is updated.
    const first = await accept(c.unsubscribe({ query: { token } }), [200]);
    expect(first.body).toStrictEqual({ unsubscribed: true });
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });

    // When + Then: the same token is idempotent.
    const second = await accept(c.unsubscribe({ query: { token } }), [200]);
    expect(second.body).toStrictEqual({ unsubscribed: true });
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });

    // Given: a token for a user that does not exist.
    const freshUserId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(freshUserId));
    const freshToken = await createToken(freshUserId);

    // When + Then: the user row is created with
    // emailUnsubscribed = true.
    const created = await accept(
      c.unsubscribe({ query: { token: freshToken } }),
      [200],
    );
    expect(created.body).toStrictEqual({ unsubscribed: true });
    await expect(findUser(freshUserId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });
  });
});

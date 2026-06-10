import { randomUUID } from "node:crypto";

import { emailUnsubscribeContract } from "@vm0/api-contracts/contracts/email-unsubscribe";
import { users } from "@vm0/db/schema/user";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { env } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import { createFixtureTracker } from "./helpers/zero-route-test";

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

async function expectJsonError(
  response: Response,
  status: number,
  error: string,
): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toStrictEqual({ error });
}

function client() {
  return setupApp({ context })(emailUnsubscribeContract);
}

describe("GET /api/email/unsubscribe", () => {
  const trackUser = createFixtureTracker<string>(async (userId) => {
    await store.set(writeDb$).delete(users).where(eq(users.id, userId));
  });

  it("returns 400 when token is missing", async () => {
    const response = await requestGetUnsubscribe();

    await expectJsonError(response, 400, "Missing token");
  });

  it("returns 400 when token is invalid", async () => {
    const response = await requestGetUnsubscribe("bad.token");

    await expectJsonError(response, 400, "Invalid token");
  });

  it("returns 400 when token signature is not hex", async () => {
    const response = await requestGetUnsubscribe(
      `user_${randomUUID()}.${"é".repeat(32)}`,
    );

    await expectJsonError(response, 400, "Invalid token");
  });

  it("unsubscribes an existing user and returns HTML confirmation", async () => {
    const userId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(userId));
    await insertUser(userId);
    const token = await createToken(userId);

    const response = await requestGetUnsubscribe(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("You have been unsubscribed");
    expect(html).toContain("http://localhost:3002/settings");
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });
  });

  it("is idempotent when the same token is used repeatedly", async () => {
    const userId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(userId));
    await insertUser(userId);
    const token = await createToken(userId);

    const firstResponse = await requestGetUnsubscribe(token);
    const secondResponse = await requestGetUnsubscribe(token);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });
  });

  it("creates an unsubscribed user row when the user does not exist", async () => {
    const userId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(userId));
    const token = await createToken(userId);

    const response = await requestGetUnsubscribe(token);

    expect(response.status).toBe(200);
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });
  });
});

describe("POST /api/email/unsubscribe", () => {
  const trackUser = createFixtureTracker<string>(async (userId) => {
    await store.set(writeDb$).delete(users).where(eq(users.id, userId));
  });

  it("returns 400 when token is missing", async () => {
    const response = await accept(client().unsubscribe({ query: {} }), [400]);

    expect(response.body).toStrictEqual({ error: "Missing token" });
  });

  it("returns 400 when token is invalid", async () => {
    const response = await accept(
      client().unsubscribe({ query: { token: "bad.token" } }),
      [400],
    );

    expect(response.body).toStrictEqual({ error: "Invalid token" });
  });

  it("returns 400 when token signature is not hex", async () => {
    const response = await accept(
      client().unsubscribe({
        query: { token: `user_${randomUUID()}.${"é".repeat(32)}` },
      }),
      [400],
    );

    expect(response.body).toStrictEqual({ error: "Invalid token" });
  });

  it("unsubscribes an existing user with a valid token", async () => {
    const userId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(userId));
    await insertUser(userId);
    const token = await createToken(userId);

    const response = await accept(
      client().unsubscribe({ query: { token } }),
      [200],
    );

    expect(response.body).toStrictEqual({ unsubscribed: true });
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });
  });

  it("is idempotent when the same token is used repeatedly", async () => {
    const userId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(userId));
    const token = await createToken(userId);

    const firstResponse = await accept(
      client().unsubscribe({ query: { token } }),
      [200],
    );
    const secondResponse = await accept(
      client().unsubscribe({ query: { token } }),
      [200],
    );

    expect(firstResponse.body).toStrictEqual({ unsubscribed: true });
    expect(secondResponse.body).toStrictEqual({ unsubscribed: true });
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });
  });

  it("creates an unsubscribed user row when the user does not exist", async () => {
    const userId = `user_${randomUUID()}`;
    await trackUser(Promise.resolve(userId));
    const token = await createToken(userId);

    const response = await accept(
      client().unsubscribe({ query: { token } }),
      [200],
    );

    expect(response.body).toStrictEqual({ unsubscribed: true });
    await expect(findUser(userId)).resolves.toStrictEqual({
      emailUnsubscribed: true,
    });
  });
});

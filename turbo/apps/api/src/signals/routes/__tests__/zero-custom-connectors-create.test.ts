import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function validBody() {
  return {
    displayName: "Example",
    prefixes: ["https://api.example.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
}

function uniqueOrg(prefix: string) {
  const userId = `user_${prefix}_${randomUUID().slice(0, 8)}`;
  const orgId = `org_${prefix}_${randomUUID().slice(0, 8)}`;
  return { userId, orgId };
}

describe("POST /api/zero/custom-connectors", () => {
  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(zeroCustomConnectorsContract);
    const response = await accept(
      client.create({ body: validBody(), headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for non-admin members", async () => {
    const { userId, orgId } = uniqueOrg("zcc-member");
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroCustomConnectorsContract);
    const response = await accept(
      client.create({
        body: validBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can create custom connectors",
        code: "FORBIDDEN",
      },
    });
  });

  it("creates a connector as admin and persists it (read-after-write)", async () => {
    const { userId, orgId } = uniqueOrg("zcc-create");
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorsContract);
    const response = await accept(
      client.create({
        body: validBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    expect(response.body.slug).toMatch(/^api-example-com-/);
    expect(response.body.displayName).toBe("Example");
    expect(response.body.prefixes).toStrictEqual(["https://api.example.com/"]);
    expect(response.body.hasSecret).toBeFalsy();

    // DB read-after-write
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select()
      .from(orgCustomConnectors)
      .where(eq(orgCustomConnectors.id, response.body.id));
    expect(row?.orgId).toBe(orgId);
    expect(row?.createdBy).toBe(userId);
  });

  it("normalises prefix to trailing slash", async () => {
    const { userId, orgId } = uniqueOrg("zcc-normalise");
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorsContract);
    const response = await accept(
      client.create({
        body: { ...validBody(), prefixes: ["https://api.example.com/v1"] },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(response.body.prefixes).toStrictEqual([
      "https://api.example.com/v1/",
    ]);
  });

  it("rejects missing {{secret}} placeholder with 400", async () => {
    const { userId, orgId } = uniqueOrg("zcc-bad-template");
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorsContract);
    const response = await accept(
      client.create({
        body: { ...validBody(), headerTemplate: "Bearer static-token" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("{{secret}}");
  });

  it("rejects non-https prefix with 400", async () => {
    const { userId, orgId } = uniqueOrg("zcc-bad-prefix");
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorsContract);
    const response = await accept(
      client.create({
        body: { ...validBody(), prefixes: ["http://api.example.com/"] },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("https");
  });

  it("rejects prefix whose host collides with a built-in connector", async () => {
    const { userId, orgId } = uniqueOrg("zcc-host-collision");
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorsContract);
    const response = await accept(
      client.create({
        body: {
          ...validBody(),
          displayName: "Fake GitHub",
          prefixes: ["https://api.github.com/v3/"],
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
    expect(response.body.error.message).toContain("api.github.com");
    expect(response.body.error.message).toContain("GitHub");
  });
});

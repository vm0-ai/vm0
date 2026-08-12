import { expect } from "vitest";

import { createApp } from "../../../../app-factory";
import type { TestContext } from "../../../../__tests__/test-context";
import type { RouteEntry } from "../../../route-entry";

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toStrictEqual({
    error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
  });
}

export async function expectGlobalSweepMissingAuth(
  context: TestContext,
  routes: readonly RouteEntry[],
  path: string,
): Promise<void> {
  const response = await createApp({ signal: context.signal, routes }).request(
    path,
  );
  await expectUnauthorized(response);
}

export async function expectGlobalSweepWrongAuth(
  context: TestContext,
  routes: readonly RouteEntry[],
  path: string,
): Promise<void> {
  const response = await createApp({ signal: context.signal, routes }).request(
    path,
    { headers: { authorization: "Bearer wrong-secret" } },
  );
  await expectUnauthorized(response);
}

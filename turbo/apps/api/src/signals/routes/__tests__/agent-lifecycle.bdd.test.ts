import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { nowDate } from "../../../lib/time";
import { createBddApi, expectApiError } from "./helpers/api-bdd";

const context = testContext();
const api = createBddApi(context);

/** Shape of the transient upstream failure R2 returns as an S3 `InternalError`. */
function objectStoreInternalError(): Error {
  const error = new Error(
    "We encountered an internal error. Please try again.",
  );
  error.name = "InternalError";
  return error;
}

describe("AGENT-01: agent lifecycle through public API", () => {
  it("creates, reads, lists, updates, deletes, and verifies removal through API-visible state", async () => {
    const admin = api.user();
    api.acceptAgentStorageWrites();

    const created = await api.createAgent(admin, {
      displayName: "BDD Research Agent",
      description: "Tracks research context",
      sound: "calm",
      avatarUrl: "preset:2",
    });

    expect(created.ownerId).toBe(admin.userId);
    expect(created.displayName).toBe("BDD Research Agent");
    expect(created.description).toBe("Tracks research context");
    expect(created.sound).toBe("calm");
    expect(created.avatarUrl).toBe("preset:2");
    expect(created.visibility).toBe("public");

    const read = await api.readAgent(admin, created.agentId);
    expect(read).toStrictEqual(created);

    const listed = await api.listAgents(admin);
    expect(
      listed.some((agent) => {
        return agent.agentId === created.agentId;
      }),
    ).toBeTruthy();

    const updated = await api.updateAgentMetadata(admin, created.agentId, {
      displayName: "BDD Research Agent Updated",
      description: "Uses only public API state",
      visibility: "private",
    });
    expect(updated.displayName).toBe("BDD Research Agent Updated");
    expect(updated.description).toBe("Uses only public API state");
    expect(updated.visibility).toBe("private");

    const readAfterUpdate = await api.readAgent(admin, created.agentId);
    expect(readAfterUpdate.displayName).toBe("BDD Research Agent Updated");
    expect(readAfterUpdate.description).toBe("Uses only public API state");
    expect(readAfterUpdate.visibility).toBe("private");

    const replaced = await api.updateAgent(admin, created.agentId, {
      displayName: "BDD Research Agent Replaced",
      description: "Updated through PUT",
      sound: "focus",
      avatarUrl: "preset:3",
      visibility: "public",
    });
    expect(replaced).toMatchObject({
      agentId: created.agentId,
      displayName: "BDD Research Agent Replaced",
      description: "Updated through PUT",
      sound: "focus",
      avatarUrl: "preset:3",
      visibility: "public",
    });

    const readAfterReplace = await api.readAgent(admin, created.agentId);
    expect(readAfterReplace).toMatchObject({
      displayName: "BDD Research Agent Replaced",
      description: "Updated through PUT",
      sound: "focus",
      avatarUrl: "preset:3",
      visibility: "public",
    });

    await api.deleteAgent(admin, created.agentId);

    const missing = await api.requestReadAgent(admin, created.agentId, [404]);
    expectApiError(missing.body);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("still reports the agent as deleted when object storage cleanup fails after the delete commits", async () => {
    const admin = api.user();
    api.acceptAgentStorageWrites();

    const created = await api.createAgent(admin, {
      displayName: "BDD Storage Cleanup Agent",
    });

    const listedPrefixes: string[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        listedPrefixes.push(prefix);
        return Promise.resolve({
          Contents: [
            {
              Key: `${prefix}AGENTS.md`,
              Size: 12,
              LastModified: nowDate(),
            },
          ],
        });
      }
      if (command instanceof DeleteObjectsCommand) {
        return Promise.reject(objectStoreInternalError());
      }
      return Promise.resolve({ ContentLength: 1024 });
    });

    // The row deletion has already committed by the time the objects are
    // released, so an upstream object-store failure must not be reported as a
    // failed deletion. `deleteAgent` accepts only 204.
    await api.deleteAgent(admin, created.agentId);

    expect(listedPrefixes.length).toBeGreaterThan(0);

    const missing = await api.requestReadAgent(admin, created.agentId, [404]);
    expectApiError(missing.body);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("returns an API error when a caller creates an agent without authentication", async () => {
    api.acceptAgentStorageWrites();

    const response = await api.requestCreateAgent(
      null,
      { displayName: "Anonymous Agent" },
      [401],
    );

    expectApiError(response.body);
    expect(response.body.error).toStrictEqual({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    });
  });
});

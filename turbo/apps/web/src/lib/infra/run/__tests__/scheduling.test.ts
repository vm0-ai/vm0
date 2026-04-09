import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import {
  insertTestRunnerState,
  deleteAllTestRunnerState,
} from "../../../../__tests__/api-test-helpers";
import { findBestRunner } from "../scheduling";

const GROUP = "vm0/test";
const PROFILE = "vm0/default";

describe("findBestRunner", () => {
  beforeEach(async () => {
    await deleteAllTestRunnerState();
  });

  it("returns null when no runners exist", async () => {
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toBeNull();
  });

  it("returns null when sessionId is null", async () => {
    await insertTestRunnerState({
      runnerId: randomUUID(),
      runnerGroup: GROUP,
      heldSessions: ["session-1"],
    });
    const result = await findBestRunner(GROUP, PROFILE, null);
    expect(result).toBeNull();
  });

  it("returns null when no runner holds the session", async () => {
    await insertTestRunnerState({
      runnerId: randomUUID(),
      runnerGroup: GROUP,
      heldSessions: ["session-other"],
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toBeNull();
  });

  it("returns the runner holding the matching session", async () => {
    const runnerId = randomUUID();
    await insertTestRunnerState({
      runnerId,
      runnerGroup: GROUP,
      heldSessions: ["session-1"],
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toEqual({ runnerId });
  });

  it("excludes stale runners (last seen > 60s ago)", async () => {
    await insertTestRunnerState({
      runnerId: randomUUID(),
      runnerGroup: GROUP,
      heldSessions: ["session-1"],
      lastSeenAt: new Date(Date.now() - 120_000),
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toBeNull();
  });

  it("excludes draining runners", async () => {
    await insertTestRunnerState({
      runnerId: randomUUID(),
      runnerGroup: GROUP,
      heldSessions: ["session-1"],
      mode: "draining",
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toBeNull();
  });

  it("excludes runners at full capacity", async () => {
    await insertTestRunnerState({
      runnerId: randomUUID(),
      runnerGroup: GROUP,
      heldSessions: ["session-1"],
      maxConcurrent: 4,
      runningCount: 4,
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toBeNull();
  });

  it("excludes runners that do not support the profile", async () => {
    await insertTestRunnerState({
      runnerId: randomUUID(),
      runnerGroup: GROUP,
      heldSessions: ["session-1"],
      profiles: ["vm0/browser"],
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toBeNull();
  });

  it("excludes runners in a different group", async () => {
    await insertTestRunnerState({
      runnerId: randomUUID(),
      runnerGroup: "vm0/other",
      heldSessions: ["session-1"],
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toBeNull();
  });

  it("treats maxConcurrent=0 as unlimited capacity", async () => {
    const runnerId = randomUUID();
    await insertTestRunnerState({
      runnerId,
      runnerGroup: GROUP,
      heldSessions: ["session-1"],
      maxConcurrent: 0,
      runningCount: 5,
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toEqual({ runnerId });
  });

  it("picks the affinity runner even with less free capacity", async () => {
    await insertTestRunnerState({
      runnerId: randomUUID(),
      runnerGroup: GROUP,
      maxConcurrent: 10,
      runningCount: 0,
      heldSessions: [],
    });
    const affinityId = randomUUID();
    await insertTestRunnerState({
      runnerId: affinityId,
      runnerGroup: GROUP,
      maxConcurrent: 4,
      runningCount: 3,
      heldSessions: ["session-1"],
    });
    const result = await findBestRunner(GROUP, PROFILE, "session-1");
    expect(result).toEqual({ runnerId: affinityId });
  });
});

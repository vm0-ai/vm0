import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { clearMockNow, mockNow, now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { storageTextFile } from "./helpers/api-bdd-chat-files";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createStoragesBddApi } from "./helpers/api-bdd-storages";

/*
 * FILE-01 storage surface: CLI prepare/commit/list/download plus
 * sandbox-token access through the run organization.
 *
 * - Version ids are server-computed SHA-256 content hashes, so version
 *   downloads always derive prefixes from real prepare responses; the
 *   ambiguous-prefix 400 is not API-constructible and is documented in the BDD
 *   exception list instead of DB-seeding a route test.
 * - STOR-01 advances mockNow between the v1 and v2 commits so the
 *   newest-first list ordering cannot tie on `updatedAt`; no run-queue
 *   state is asserted under the mocked clock.
 * - Write-side sandbox prepare/commit, 413 totals, version-id mismatch,
 *   and dedup re-commit statements stay covered by the alive
 *   `webhooks-agent-storage.test.ts`.
 */

const context = testContext();
const bdd = createBddApi(context);
const api = createStoragesBddApi(context);
const authOrg = createAuthOrgAgentsBddApi(context);

afterEach(() => {
  clearMockNow();
});

describe("FILE-01 storage prepare, commit, list, and download", () => {
  it("chains the cli storage lifecycle with version history and upload-failure recovery", async () => {
    const actor = bdd.user();
    api.mockStoragePresignedUrls();
    api.mockStorageObjectsExist();
    const base = now();
    mockNow(base);

    const invalidPrepare = await api.requestPrepareStorage(
      actor,
      { storageType: "artifact", files: [] },
      [400],
    );
    expectApiError(invalidPrepare.body);
    expect(invalidPrepare.body.error.code).toBe("BAD_REQUEST");
    expect(invalidPrepare.body.error.message).toContain("storageName");

    const noOrgPrepare = await api.requestPrepareStorage(
      bdd.user({ orgId: null }),
      { storageName: "bdd-no-org", storageType: "artifact", files: [] },
      [400],
    );
    expectApiError(noOrgPrepare.body);
    expect(noOrgPrepare.body.error.message).toContain("Explicit org context");

    const name = `bdd-lifecycle-${randomUUID().slice(0, 8)}`;
    const v1File = storageTextFile("notes.txt", "version one");
    const v1Files = [v1File];
    const prepared = await api.prepareStorage(actor, {
      storageName: name,
      storageType: "artifact",
      files: v1Files,
    });
    expect(prepared.existing).toBeFalsy();
    expect(prepared.uploads?.archive.key).toBe(
      `${actor.orgId}/artifact/${name}/${prepared.versionId}/archive.tar.gz`,
    );
    expect(prepared.uploads?.manifest.key).toBe(
      `${actor.orgId}/artifact/${name}/${prepared.versionId}/manifest.json`,
    );
    expect(prepared.uploads?.archive.presignedUrl).toMatch(/^https?:\/\//);

    const pairName = `bdd-pair-${randomUUID().slice(0, 8)}`;
    const pairFiles = [
      storageTextFile("a.txt", "alpha content"),
      storageTextFile("b.txt", "bravo content"),
    ];
    const pairForward = await api.prepareStorage(actor, {
      storageName: pairName,
      storageType: "artifact",
      files: pairFiles,
    });
    const pairReversed = await api.prepareStorage(actor, {
      storageName: pairName,
      storageType: "artifact",
      files: [...pairFiles].reverse(),
    });
    expect(pairReversed.versionId).toBe(pairForward.versionId);

    const beforeCommit = await api.requestDownloadStorage(
      actor,
      { name, type: "artifact" },
      [404],
    );
    expectApiError(beforeCommit.body);
    expect(beforeCommit.body.error.message).toContain("has no versions");

    const v1Commit = {
      storageName: name,
      storageType: "artifact" as const,
      versionId: prepared.versionId,
      files: v1Files,
    };

    api.mockStorageObjectMissingOnce();
    const missingManifest = await api.requestCommitStorage(
      actor,
      v1Commit,
      [400],
    );
    expectApiError(missingManifest.body);
    expect(missingManifest.body.error.message).toContain(
      "Manifest not uploaded",
    );

    api.mockStorageObjectExistsOnce();
    api.mockStorageObjectMissingOnce();
    const missingArchive = await api.requestCommitStorage(
      actor,
      v1Commit,
      [400],
    );
    expectApiError(missingArchive.body);
    expect(missingArchive.body.error.message).toContain("Archive not uploaded");

    const committed = await api.commitStorage(actor, {
      ...v1Commit,
      message: "version one",
    });
    expect(committed).toMatchObject({
      success: true,
      storageName: name,
      versionId: prepared.versionId,
      size: v1File.size,
      fileCount: 1,
    });

    const listedAfterV1 = await api.listStorages(actor, "artifact");
    expect(
      listedAfterV1.some((item) => {
        return item.name === name && item.fileCount === 1;
      }),
    ).toBeTruthy();

    mockNow(base + 5000);
    const v2File = storageTextFile("notes.txt", "version two with more text");
    const v2Files = [v2File];
    const preparedV2 = await api.prepareStorage(actor, {
      storageName: name,
      storageType: "artifact",
      files: v2Files,
    });
    expect(preparedV2.versionId).not.toBe(prepared.versionId);
    await api.commitStorage(actor, {
      storageName: name,
      storageType: "artifact",
      versionId: preparedV2.versionId,
      files: v2Files,
    });

    const headDownload = await api.downloadStorage(actor, {
      name,
      type: "artifact",
    });
    expect(headDownload).toMatchObject({
      versionId: preparedV2.versionId,
      fileCount: 1,
      size: v2File.size,
    });
    expect("url" in headDownload ? headDownload.url : "").toMatch(
      /^https?:\/\//,
    );
    expect(api.lastPresignedUrlKey()).toBe(
      `${actor.orgId}/artifact/${name}/${preparedV2.versionId}/archive.tar.gz`,
    );

    const ordered = await api.listStorages(actor, "artifact");
    expect(
      ordered.map((item) => {
        return item.name;
      }),
    ).toStrictEqual([name, pairName]);

    const v1FullVersion = await api.downloadStorage(actor, {
      name,
      type: "artifact",
      version: prepared.versionId,
    });
    expect(v1FullVersion).toMatchObject({
      versionId: prepared.versionId,
      fileCount: 1,
      size: v1File.size,
    });

    const v1ByPrefix = await api.downloadStorage(actor, {
      name,
      type: "artifact",
      version: prepared.versionId.slice(0, 8),
    });
    expect(v1ByPrefix).toMatchObject({ versionId: prepared.versionId });

    const usedPrefixes = new Set([
      prepared.versionId.slice(0, 8),
      preparedV2.versionId.slice(0, 8),
    ]);
    const unmatchedPrefix = [..."0123456789abcdef"]
      .map((digit) => {
        return `${digit}${prepared.versionId.slice(1, 8)}`;
      })
      .find((candidate) => {
        return !usedPrefixes.has(candidate);
      });
    if (!unmatchedPrefix) {
      throw new Error("Expected an 8-hex prefix matching neither version");
    }
    const noMatch = await api.requestDownloadStorage(
      actor,
      { name, type: "artifact", version: unmatchedPrefix },
      [404],
    );
    expectApiError(noMatch.body);
    expect(noMatch.body.error.message).toContain("not found");

    api.mockStorageObjectMissingOnce();
    const conflicted = await api.requestCommitStorage(actor, v1Commit, [409]);
    expectApiError(conflicted.body);
    expect(conflicted.body.error).toStrictEqual({
      message: "S3 files missing for existing version - please retry upload",
      code: "S3_FILES_MISSING",
    });

    const deduplicated = await api.commitStorage(actor, v1Commit);
    expect(deduplicated.deduplicated).toBeTruthy();
    expect(deduplicated.versionId).toBe(prepared.versionId);

    const headAfterDedup = await api.downloadStorage(actor, {
      name,
      type: "artifact",
    });
    expect(headAfterDedup).toMatchObject({ versionId: prepared.versionId });

    const invalidCommit = await api.requestCommitStorage(
      actor,
      { storageType: "artifact", versionId: "0".repeat(64), files: [] },
      [400],
    );
    expectApiError(invalidCommit.body);
    expect(invalidCommit.body.error.code).toBe("BAD_REQUEST");
    expect(invalidCommit.body.error.message).toContain("storageName");

    const neverPrepared = await api.requestCommitStorage(
      actor,
      {
        storageName: `bdd-missing-${randomUUID().slice(0, 8)}`,
        storageType: "artifact",
        versionId: prepared.versionId,
        files: v1Files,
      },
      [404],
    );
    expectApiError(neverPrepared.body);
    expect(neverPrepared.body.error.message).toContain("not found");

    const peer = bdd.user({ orgId: actor.orgId, orgRole: "org:member" });
    const peerList = await api.listStorages(peer, "artifact");
    expect(
      peerList.some((item) => {
        return item.name === name;
      }),
    ).toBeFalsy();

    const outsider = bdd.user();
    const crossUserDownload = await api.requestDownloadStorage(
      outsider,
      { name, type: "artifact" },
      [404],
    );
    expectApiError(crossUserDownload.body);
    expect(crossUserDownload.body.error.code).toBe("NOT_FOUND");
  });

  it("serves empty artifacts, volumes, and cli bearer access through visible reads", async () => {
    const actor = bdd.user();
    api.mockStoragePresignedUrls();
    api.mockStorageObjectsExist();

    const emptyName = `bdd-empty-${randomUUID().slice(0, 8)}`;
    const preparedEmpty = await api.prepareStorage(actor, {
      storageName: emptyName,
      storageType: "artifact",
      files: [],
    });
    const committedEmpty = await api.commitStorage(actor, {
      storageName: emptyName,
      storageType: "artifact",
      versionId: preparedEmpty.versionId,
      files: [],
    });
    expect(committedEmpty).toMatchObject({
      success: true,
      fileCount: 0,
      size: 0,
    });

    context.mocks.s3.getSignedUrl.mockClear();
    const emptyDownload = await api.downloadStorage(actor, {
      name: emptyName,
      type: "artifact",
    });
    expect(emptyDownload).toStrictEqual({
      empty: true,
      versionId: preparedEmpty.versionId,
      fileCount: 0,
      size: 0,
    });
    expect(context.mocks.s3.getSignedUrl).not.toHaveBeenCalled();

    const volumeName = `bdd-volume-${randomUUID().slice(0, 8)}`;
    const volumeFile = storageTextFile("data/cache.bin", "volume payload");
    const preparedVolume = await api.prepareStorage(actor, {
      storageName: volumeName,
      storageType: "volume",
      files: [volumeFile],
    });
    await api.commitStorage(actor, {
      storageName: volumeName,
      storageType: "volume",
      versionId: preparedVolume.versionId,
      files: [volumeFile],
    });

    const volumes = await api.listStorages(actor, "volume");
    expect(
      volumes.map((item) => {
        return item.name;
      }),
    ).toStrictEqual([volumeName]);

    const artifacts = await api.listStorages(actor, "artifact");
    expect(
      artifacts.some((item) => {
        return item.name === volumeName;
      }),
    ).toBeFalsy();
    expect(
      artifacts.some((item) => {
        return item.name === emptyName;
      }),
    ).toBeTruthy();

    const volumeDownload = await api.downloadStorage(actor, {
      name: volumeName,
      type: "volume",
    });
    expect(volumeDownload).toMatchObject({
      versionId: preparedVolume.versionId,
      fileCount: 1,
      size: volumeFile.size,
    });

    authOrg.mockClerkOrg(actor);
    const key = await authOrg.createApiKey(actor, {
      name: "BDD storages token",
      expiresInDays: 7,
    });
    const bearerList = await api.requestListStoragesWithBearer(
      key.token,
      "artifact",
      [200],
    );
    if (bearerList.status !== 200) {
      throw new Error("Expected the CLI bearer token to list storages");
    }
    expect(
      bearerList.body.some((item) => {
        return item.name === emptyName;
      }),
    ).toBeTruthy();
  });

  it("scopes sandbox-token storage reads through the run organization", async () => {
    const runs = createRunsAutomationsApi(context);
    const actor = bdd.user();
    bdd.acceptAgentStorageWrites();
    runs.acceptStorageDownloads();
    runs.acceptTelemetryIngest();
    runs.configureRunnerGroup();
    await runs.grantProEntitlement(actor);
    await runs.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD storage sandbox agent",
      description: "Scopes sandbox storage reads through the run org.",
      visibility: "private",
    });
    const run = await runs.createRun(actor, {
      agentId: agent.agentId,
      prompt: "read org storages from the sandbox",
      modelProvider: "anthropic-api-key",
    });

    const artifactName = `bdd-sandbox-artifact-${randomUUID().slice(0, 8)}`;
    const artifactFile = storageTextFile("report.md", "sandbox readable");
    const preparedArtifact = await api.prepareStorage(actor, {
      storageName: artifactName,
      storageType: "artifact",
      files: [artifactFile],
    });
    await api.commitStorage(actor, {
      storageName: artifactName,
      storageType: "artifact",
      versionId: preparedArtifact.versionId,
      files: [artifactFile],
    });

    const volumeName = `bdd-sandbox-volume-${randomUUID().slice(0, 8)}`;
    const volumeFile = storageTextFile("cache/data.bin", "sandbox volume");
    const preparedVolume = await api.prepareStorage(actor, {
      storageName: volumeName,
      storageType: "volume",
      files: [volumeFile],
    });
    await api.commitStorage(actor, {
      storageName: volumeName,
      storageType: "volume",
      versionId: preparedVolume.versionId,
      files: [volumeFile],
    });

    const sandboxToken = runs.sandboxTokenForRun(actor, run.runId);
    const sandboxArtifacts = await api.requestListStoragesWithBearer(
      sandboxToken,
      "artifact",
      [200],
    );
    if (sandboxArtifacts.status !== 200) {
      throw new Error("Expected the sandbox token to list artifacts");
    }
    expect(
      sandboxArtifacts.body.some((item) => {
        return item.name === artifactName;
      }),
    ).toBeTruthy();

    const sandboxVolumes = await api.requestListStoragesWithBearer(
      sandboxToken,
      "volume",
      [200],
    );
    if (sandboxVolumes.status !== 200) {
      throw new Error("Expected the sandbox token to list volumes");
    }
    expect(
      sandboxVolumes.body.some((item) => {
        return item.name === volumeName;
      }),
    ).toBeTruthy();

    const sandboxDownload = await api.requestDownloadStorageWithBearer(
      sandboxToken,
      { name: artifactName, type: "artifact" },
      [200],
    );
    if (sandboxDownload.status !== 200) {
      throw new Error("Expected the sandbox token to download the artifact");
    }
    expect(sandboxDownload.body).toMatchObject({
      versionId: preparedArtifact.versionId,
      fileCount: 1,
      size: artifactFile.size,
    });

    const orphanToken = runs.sandboxTokenForRun(actor, randomUUID());
    const orphanList = await api.requestListStoragesWithBearer(
      orphanToken,
      "artifact",
      [404],
    );
    expect(orphanList.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    const orphanDownload = await api.requestDownloadStorageWithBearer(
      orphanToken,
      { name: artifactName, type: "artifact" },
      [404],
    );
    expect(orphanDownload.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    await runs.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await runs.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("rejects unauthenticated and invalid storage requests with contract errors", async () => {
    const unauthenticatedBody = {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    };

    const unauthenticatedList = await api.requestListStorages(
      null,
      { type: "artifact" },
      [401],
    );
    expect(unauthenticatedList.body).toStrictEqual(unauthenticatedBody);

    const unauthenticatedDownload = await api.requestDownloadStorage(
      null,
      { name: "missing", type: "artifact" },
      [401],
    );
    expect(unauthenticatedDownload.body).toStrictEqual(unauthenticatedBody);

    const unauthenticatedPrepare = await api.requestPrepareStorage(
      null,
      { storageName: "missing", storageType: "artifact", files: [] },
      [401],
    );
    expect(unauthenticatedPrepare.body).toStrictEqual(unauthenticatedBody);

    const unauthenticatedCommit = await api.requestCommitStorage(
      null,
      {
        storageName: "missing",
        storageType: "artifact",
        versionId: "0".repeat(64),
        files: [],
      },
      [401],
    );
    expect(unauthenticatedCommit.body).toStrictEqual(unauthenticatedBody);

    const actor = bdd.user();
    const invalidListType = await api.requestListStorages(
      actor,
      { type: "invalid" },
      [400],
    );
    expectApiError(invalidListType.body);
    expect(invalidListType.body.error.message).toContain("type");

    const missingName = await api.requestDownloadStorage(
      actor,
      { type: "artifact" },
      [400],
    );
    expectApiError(missingName.body);
    expect(missingName.body.error.message).toContain("name");

    const missingType = await api.requestDownloadStorage(
      actor,
      { name: "missing" },
      [400],
    );
    expectApiError(missingType.body);
    expect(missingType.body.error.message).toContain("type");

    const invalidType = await api.requestDownloadStorage(
      actor,
      { name: "missing", type: "invalid" },
      [400],
    );
    expectApiError(invalidType.body);
    expect(invalidType.body.error.message).toContain("type");

    const tooShortVersion = await api.requestDownloadStorage(
      actor,
      { name: "missing", type: "artifact", version: "abcdefg" },
      [400],
    );
    expectApiError(tooShortVersion.body);
    expect(tooShortVersion.body.error.message).toContain("8");

    const invalidHexVersion = await api.requestDownloadStorage(
      actor,
      { name: "missing", type: "artifact", version: "ghijklmn" },
      [400],
    );
    expectApiError(invalidHexVersion.body);
    expect(invalidHexVersion.body.error.message).toContain("hex");
  });
});

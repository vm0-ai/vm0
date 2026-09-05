import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { piLaunchConfigSchema } from "@okouai/api-contracts/contracts/runners";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { piMemoryPhase2Checkpoints } from "@okouai/db/schema/pi-memory-phase2-checkpoint";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { storageVersionLineage } from "@okouai/db/schema/storage-version-lineage";
import { storages } from "@okouai/db/schema/storage";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { createStore } from "ccstate";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { guestBoundaryEnvironment } from "../../../__tests__/env-stub";
import { nowDate } from "../../../lib/time";
import { settle } from "../../utils";
import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { mockOptionalEnv } from "../../../lib/env";
import { seedOrgMetadata } from "../../../test-fixtures/system-config-seeds";
import { generateSandboxToken } from "../../auth/tokens";
import { webhooksAgentCompleteRoutes } from "../../routes/webhooks-agent-complete";
import { webhooksAgentHealthUsageTelemetryRoutes } from "../../routes/webhooks-agent-health-usage-telemetry";
import { webhooksAgentStorageRoutes } from "../../routes/webhooks-agent-storage";
import { seedBuiltInModelKey } from "../../routes/__tests__/helpers/runtime-state";
import {
  advancePiMemoryPhase2InputRevision,
  notifyPiMemoryPhase2ExternalHeadChange,
} from "../pi-memory-phase2-job.service";
import { DEFAULT_AGENT_NAME } from "../default-agent-profile";
import { executePiMemoryPhase2Work$ } from "../pi-memory-phase2-worker.service";
import {
  piMemoryPhase2MaintenanceCallbackPayloadSchema,
  handlePiMemoryPhase2MaintenanceCallback,
} from "../pi-memory-phase2-maintenance.service";
import {
  createPhase2TestScope,
  insertPendingPhase2Job,
  insertPhase2Candidates,
  readPhase2Job,
  insertPhase2StorageVersion,
  setPhase2StorageHead,
} from "./pi-memory-phase2-job.test-fixture";

const context = testContext();
const guestEnvironment = guestBoundaryEnvironment();
const repo = resolve(
  fileURLToPath(new URL("../../../../../../..", import.meta.url)),
);
const cargo = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: resolve(repo, "crates"),
    encoding: "utf8",
  }),
) as { target_directory: string };
const secretCandidate = "PRIVATE_CANDIDATE_31937";

function sse(response: ServerResponse, index: number, failure: boolean) {
  const id = `resp_boundary_${index}`;
  const text = "Maintenance completed";
  const tool = index < 2;
  const item = tool
    ? {
        type: "function_call",
        id: `fc_${index}`,
        call_id: `call_${index}`,
        name: "phase2_write",
        arguments: JSON.stringify({
          path: index === 0 ? "memory/MEMORY.md" : "memory/memory_summary.md",
          content:
            index === 0
              ? "# Task Group: boundary\n"
              : "v1\n## User Profile\n- boundary\n",
        }),
        status: "completed",
      }
    : {
        type: "message",
        id: `msg_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
  const events = [
    {
      type: "response.created",
      response: {
        id,
        object: "response",
        status: "in_progress",
        output: [],
        usage: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: tool
        ? { ...item, arguments: "", status: "in_progress" }
        : { ...item, content: [], status: "in_progress" },
    },
    tool
      ? {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          item_id: item.id,
          delta: item.arguments,
        }
      : {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: text,
        },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        object: "response",
        status: "completed",
        output: [item],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      },
    },
  ];
  if (failure && index > 0) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: {
          message: "provider boundary failure",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    events
      .map((event) => {
        return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      })
      .join(""),
  );
}

type Fault =
  | "none"
  | "commit_ack"
  | "complete_transaction"
  | "complete_ack"
  | "provider"
  | "abrupt"
  | "revoked"
  | "invalid_marker"
  | "observer"
  | "new_input";

async function launch(fault: Fault, noDiff = false) {
  const scope = await createPhase2TestScope(`boundary-${fault}`, {
    emptyBase: true,
  });
  const baseFiles = noDiff
    ? [
        { path: "MEMORY.md", content: "# Task Group: boundary\n" },
        {
          path: "memory_summary.md",
          content: "v1\n## User Profile\n- boundary\n",
        },
      ]
    : [];
  const files = baseFiles.map((file) => {
    return {
      path: file.path,
      size: Buffer.byteLength(file.content),
      hash: createHash("sha256").update(file.content).digest("hex"),
    };
  });
  const baseVersion = noDiff
    ? await insertPhase2StorageVersion(scope, "valid-base", {
        versionId: createHash("sha256")
          .update(
            `storage:${scope.memoryStorageId}\n${files
              .map((file) => {
                return `${file.path}:${file.hash}`;
              })
              .sort()
              .join("\n")}`,
          )
          .digest("hex"),
        fileCount: files.length,
        size: files.reduce((sum, file) => {
          return sum + file.size;
        }, 0),
        archiveSize: 1,
      })
    : scope.baseVersion;
  if (noDiff) {
    await setPhase2StorageHead(scope, baseVersion);
  }
  await seedOrgMetadata({ orgId: scope.orgId, tier: "pro", credits: 100_000 });
  const agentId = randomUUID();
  await db().insert(agents).values({
    id: agentId,
    orgId: scope.orgId,
    owner: scope.userId,
    name: DEFAULT_AGENT_NAME,
    visibility: "public",
  });
  const cleanup: { runId?: string } = {};
  onTestFinished(async () => {
    await db().delete(usageEvent).where(eq(usageEvent.orgId, scope.orgId));
    if (cleanup.runId) {
      await db().delete(agentRuns).where(eq(agentRuns.id, cleanup.runId));
    }
    await db().delete(agents).where(eq(agents.id, agentId));
  });
  await seedBuiltInModelKey(context, "gpt-5.6-terra");
  context.mocks.s3.getSignedUrl.mockResolvedValue(
    "https://objects.example.test/private-first-turn",
  );
  if (!noDiff) {
    await insertPhase2Candidates(scope, [
      {
        piSessionId: randomUUID(),
        rawMemory: secretCandidate,
        rolloutSummary: "private evidence",
      },
    ]);
  }
  await insertPendingPhase2Job(scope, { updatedAt: nowDate() });
  mockOptionalEnv("RUNNER_DEFAULT_GROUP", "vm0/test");
  const result = await createStore().set(
    executePiMemoryPhase2Work$,
    { scope, currentTime: nowDate() },
    context.signal,
  );
  expect(result.outcome).toBe("dispatched");
  if (result.outcome !== "dispatched") {
    throw new Error("Maintenance dispatch failed");
  }
  cleanup.runId = result.runId;
  // Runner activation is the only run-state fixture. Guest creates all session
  // metadata, checkpoint requests, completion state and control settlement.
  await db()
    .update(agentRuns)
    .set({ status: "running" })
    .where(eq(agentRuns.id, result.runId));
  const [callback] = await db()
    .select()
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, result.runId));
  const binding = piMemoryPhase2MaintenanceCallbackPayloadSchema.parse(
    callback?.payload,
  );
  const [queued] = await db()
    .select()
    .from(runnerJobQueue)
    .where(eq(runnerJobQueue.runId, result.runId));
  const execution = z
    .object({ piLaunchConfig: piLaunchConfigSchema })
    .parse(queued?.executionContext);
  const trigger = `maintenance_observer_${scope.memoryStorageId.replaceAll("-", "")}`;
  async function releaseObserver() {
    if (fault === "observer") {
      await db().execute(
        sql`DROP TRIGGER IF EXISTS ${sql.identifier(trigger)} ON pi_memory_phase2_jobs`,
      );
      await db().execute(
        sql`DROP FUNCTION IF EXISTS ${sql.identifier(trigger)}()`,
      );
    }
  }
  if (fault === "observer") {
    await db()
      .execute(sql`CREATE FUNCTION ${sql.identifier(trigger)}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF replace(NEW.memory_storage_id::text, '-', '') = right(TG_NAME, 32) AND NEW.last_maintenance_checkpoint_id IS NOT NULL THEN
        RAISE EXCEPTION 'deterministic observer failure';
      END IF; RETURN NEW; END $$`);
    await db().execute(
      sql`CREATE TRIGGER ${sql.identifier(trigger)} BEFORE UPDATE ON pi_memory_phase2_jobs FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(trigger)}()`,
    );
    onTestFinished(releaseObserver);
  }
  const root = await mkdtemp(join(tmpdir(), "pi-maintenance-boundary-"));
  onTestFinished(() => {
    return rm(root, { recursive: true, force: true });
  });
  const memory = join(root, "memory");
  const runtime = join(root, "runtime");
  const bin = join(root, "bin");
  await Promise.all(
    [memory, bin, join(runtime, "run-payload"), join(runtime, "user-env")].map(
      (path) => {
        return mkdir(path, { recursive: true });
      },
    ),
  );
  await Promise.all(
    baseFiles.map((file) => {
      return writeFile(join(memory, file.path), file.content);
    }),
  );
  const [mountedRun] = await db()
    .select({ storageMounts: agentRuns.storageMounts })
    .from(agentRuns)
    .where(eq(agentRuns.id, result.runId));
  await db()
    .update(agentRuns)
    .set({
      storageMounts: mountedRun?.storageMounts?.map((mount) => {
        return { ...mount, mountPath: memory };
      }),
    })
    .where(eq(agentRuns.id, result.runId));
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: [
      ...webhooksAgentCompleteRoutes,
      ...webhooksAgentHealthUsageTelemetryRoutes,
      ...webhooksAgentStorageRoutes,
    ],
  });
  const objects = new Map<string, Buffer>();
  if (noDiff) {
    objects.set(`${baseVersion.s3Key}/archive.tar.gz`, Buffer.from("base"));
    objects.set(
      `${baseVersion.s3Key}/manifest.json`,
      Buffer.from(JSON.stringify({ files })),
    );
  }
  const requests: { path: string; body: string; status: number }[] = [];
  let providerCount = 0;
  let commitCount = 0;
  let baseUrl = "";
  async function respondProvider(response: ServerResponse): Promise<void> {
    if (providerCount === 1 && fault === "new_input") {
      await insertPhase2Candidates(scope, [
        {
          piSessionId: randomUUID(),
          rawMemory: "later candidate",
          rolloutSummary: "later evidence",
        },
      ]);
      await db().transaction((tx) => {
        return advancePiMemoryPhase2InputRevision(tx, {
          ...scope,
          enqueuedAt: nowDate(),
        });
      });
    }
    if (providerCount === 1 && fault === "abrupt") {
      const pid = Number(await readFile(join(root, "child.pid"), "utf8"));
      process.kill(pid, "SIGKILL");
      response.destroy();
      return;
    }
    sse(response, providerCount++, fault === "provider");
    return;
  }
  const server = createServer(async (request, response) => {
    const served = await settle(
      (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        const path = request.url ?? "/";
        if (path === "/v1/responses") {
          await respondProvider(response);
          return;
        }
        if (path.startsWith("/s3/")) {
          objects.set(decodeURIComponent(path.slice(4)), bytes);
          response.writeHead(200);
          response.end();
          return;
        }
        if (path.endsWith("/complete") && fault === "complete_transaction") {
          requests.push({ path, body: bytes.toString(), status: 503 });
          response.writeHead(503);
          response.end("unavailable");
          return;
        }
        if (path.endsWith("/pi-memory-phase2/usage")) {
          if (fault === "revoked") {
            const replacement = randomUUID();
            await db()
              .update(piMemoryPhase2Jobs)
              .set({ leaseToken: replacement, sandboxLeaseToken: replacement })
              .where(
                eq(piMemoryPhase2Jobs.memoryStorageId, scope.memoryStorageId),
              );
          }
          if (fault === "invalid_marker") {
            const marker = join(
              runtime,
              "pi-launch-payload/maintenance-validation.json",
            );
            // The HTTP usage boundary is after the real child exits, before Guest
            // checkpoint preparation. This mutation never injects valid evidence.
            await writeFile(marker, "{}", { mode: 0o600 });
          }
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (typeof value === "string") {
            headers.set(key, value);
          }
        }
        const apiResponse = await app.request(path, {
          method: request.method,
          headers,
          ...(bytes.length ? { body: bytes } : {}),
        });
        const body = await apiResponse.text();
        requests.push({
          path,
          body: bytes.toString(),
          status: apiResponse.status,
        });
        if (path.endsWith("/commit")) {
          commitCount += 1;
        }
        if (
          (path.endsWith("/commit") &&
            fault === "commit_ack" &&
            commitCount === 1) ||
          (path.endsWith("/complete") && fault === "complete_ack")
        ) {
          // Transaction has completed; destroy only its HTTP acknowledgement.
          response.destroy();
          return;
        }
        response.writeHead(
          apiResponse.status,
          Object.fromEntries(apiResponse.headers),
        );
        response.end(body);
      })(),
      context.signal,
    );
    if (!served.ok) {
      response.writeHead(500);
      response.end(String(served.error));
    }
  });
  const listening = once(server, "listening", { signal: context.signal });
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing listener");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  onTestFinished(async () => {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
  });
  context.mocks.s3.getSignedUrl.mockImplementation((_client, command) => {
    const input = (command as { input: { Key: string } }).input;
    return Promise.resolve(`${baseUrl}/s3/${encodeURIComponent(input.Key)}`);
  });
  context.mocks.s3.send.mockImplementation((command) => {
    const input = (command as { input: { Key?: string } }).input;
    const object = input.Key ? objects.get(input.Key) : undefined;
    if (!object) {
      throw Object.assign(new Error("Object missing"), { name: "NotFound" });
    }
    return Promise.resolve({
      ContentLength: object.length,
      Body: Readable.from([object]),
    });
  });
  const token = generateSandboxToken(scope.userId, result.runId, scope.orgId);
  const quote = (value: string) => {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
  };
  const fixture = resolve(
    repo,
    "turbo/apps/cli/src/test/fixtures/pi-agent-loop-rpc-host.ts",
  );
  const shim = `#!/bin/sh\nprintf '%s' "$$" > ${quote(join(root, "child.pid"))}\nexec ${[process.execPath, "--import", import.meta.resolve("tsx"), fixture, join(root, "agent"), join(root, "sessions"), memory].map(quote).join(" ")}\n`;
  await writeFile(join(bin, "npx"), shim, { mode: 0o700 });
  const payloadFile = join(runtime, "run-payload/payload.json");
  const userEnvFile = join(runtime, "user-env/env.json");
  await writeFile(
    payloadFile,
    JSON.stringify({
      prompt: "Run first-party Pi memory maintenance.",
      piSessionId: result.runId,
      artifacts: JSON.stringify([
        {
          name: "memory",
          storageId: scope.memoryStorageId,
          versionId: baseVersion.versionId,
          mountPath: memory,
          missingRootPolicy: "fail",
        },
      ]),
      piLaunchConfig: JSON.stringify(execution.piLaunchConfig),
      piModelConfig: JSON.stringify({
        provider: "openai",
        model: "gpt-5.6-terra",
        api: "openai-responses",
        baseUrl: `${baseUrl}/v1`,
        apiKeyEnv: "OPENAI_API_KEY",
        credentialSecretName: "OPENAI_API_KEY",
      }),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    userEnvFile,
    JSON.stringify({
      CLI_PKG_URL: "boundary-cli",
      OPENAI_API_KEY: "boundary-provider-key",
      PATH: `${bin}:${guestEnvironment.PATH ?? ""}`,
    }),
    { mode: 0o600 },
  );
  const child = spawn(
    resolve(cargo.target_directory, "local/guest-agent"),
    [],
    {
      env: {
        HOME: guestEnvironment.HOME,
        OKOU_RUN_ID: result.runId,
        OKOU_API_BACKEND_URL: baseUrl,
        OKOU_API_TOKEN: token,
        CLI_AGENT_TYPE: "pi",
        OKOU_GUEST_RUNTIME_DIR: runtime,
        OKOU_RUN_PAYLOAD_FILE: payloadFile,
        OKOU_USER_ENV_FILE: userEnvFile,
        OKOU_TEST_DISABLE_HTTP_RETRY_DELAY: "1",
        PATH: `${bin}:${guestEnvironment.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += String(bytes);
  });
  child.stderr.on("data", (bytes) => {
    output += String(bytes);
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  const [exit] = await once(child, "exit", { signal: context.signal });
  const job = await readPhase2Job(scope);
  const receipts = await db()
    .select()
    .from(piMemoryPhase2Checkpoints)
    .where(eq(piMemoryPhase2Checkpoints.runId, result.runId));
  const checkpointRows = await db()
    .select()
    .from(checkpoints)
    .where(eq(checkpoints.runId, result.runId));
  const lineage = await db()
    .select()
    .from(storageVersionLineage)
    .where(eq(storageVersionLineage.runId, result.runId));
  const usage = await db()
    .select()
    .from(usageEvent)
    .where(eq(usageEvent.orgId, scope.orgId));
  const [run] = await db()
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, result.runId));
  expect(output).not.toContain(secretCandidate);
  expect(
    requests
      .map((request) => {
        return request.body;
      })
      .join("\n"),
  ).not.toContain(secretCandidate);
  return {
    scope,
    binding,
    runId: result.runId,
    token,
    app,
    output,
    exit,
    job,
    receipts,
    checkpointRows,
    lineage,
    usage,
    run,
    requests,
    providerCount,
    objects,
    memory,
    releaseObserver,
  };
}

describe("private maintenance across CLI, Guest, generic checkpoint and real PostgreSQL", () => {
  it.each([
    "none",
    "commit_ack",
    "complete_transaction",
    "complete_ack",
    "observer",
    "new_input",
  ] as const)(
    "settles changed output exactly once through %s",
    async (fault) => {
      const run = await launch(fault);
      expect(run.job, run.output).toMatchObject({
        completedRevision: 1,
        retryCount: 0,
        lastMaintenanceOutcome: "published",
      });
      expect(run.receipts).toHaveLength(1);
      expect(run.lineage).toHaveLength(1);
      expect(run.providerCount).toBe(3);
      expect(run.usage.length).toBeGreaterThan(0);
      expect(
        run.usage.every((entry) => {
          return entry.runId === null;
        }),
      ).toBeTruthy();
      await expect(
        readFile(join(run.memory, "MEMORY.md"), "utf8"),
      ).resolves.toContain("boundary");
      if (fault === "complete_transaction") {
        expect(run.checkpointRows).toHaveLength(0);
        expect(run.run?.status).toBe("running");
      } else {
        expect(run.checkpointRows).toHaveLength(1);
        expect(run.run?.status).toBe("completed");
      }
      if (fault === "observer") {
        expect(run.job?.lastMaintenanceCheckpointId).toBeNull();
        await run.releaseObserver();
      }
      await handlePiMemoryPhase2MaintenanceCallback(db(), {
        runId: run.runId,
        payload: run.binding,
        status: "completed",
      });
      const selected = await db()
        .select()
        .from(piMemoryStage1Candidates)
        .where(
          eq(
            piMemoryStage1Candidates.memoryStorageId,
            run.scope.memoryStorageId,
          ),
        );
      expect(
        selected.filter((candidate) => {
          return candidate.lastSelectedSourceHistoryHash !== null;
        }),
      ).toHaveLength(1);
      if (fault === "new_input") {
        expect(run.job).toMatchObject({
          inputRevision: 2,
          completedRevision: 1,
          status: "pending",
        });
        expect(selected).toHaveLength(2);
      }
      // A subsequent ordinary writer owns the current HEAD; replay only ACKs
      // the old receipt and must preserve the new input and observed HEAD.
      const later = await insertPhase2StorageVersion(
        run.scope,
        "later-external",
      );
      await setPhase2StorageHead(run.scope, later);
      await db().transaction((tx) => {
        return notifyPiMemoryPhase2ExternalHeadChange(tx, {
          ...run.scope,
          observedHeadVersionId: later.versionId,
          changedAt: nowDate(),
        });
      });
      const beforeReplay = await readPhase2Job(run.scope);
      const commit = run.requests.find((request) => {
        return request.path.endsWith("/commit");
      });
      expect(commit).toBeDefined();
      if (!commit) {
        throw new Error("Missing real Guest commit");
      }
      const replay = await run.app.request(commit.path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${run.token}`,
          "content-type": "application/json",
        },
        body: commit.body,
      });
      expect(replay.status).toBe(200);
      await expect(readPhase2Job(run.scope)).resolves.toStrictEqual(
        beforeReplay,
      );
      const [head] = await db()
        .select()
        .from(storages)
        .where(eq(storages.id, run.scope.memoryStorageId));
      expect(head?.headVersionId).toBe(later.versionId);
      const wrongClaim = JSON.parse(commit.body);
      expect(wrongClaim.maintenanceAttestation.schemaVersion).toBe(2);
      wrongClaim.maintenanceAttestation.leaseToken = randomUUID();
      expect(
        (
          await run.app.request(commit.path, {
            method: "POST",
            headers: {
              authorization: `Bearer ${run.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(wrongClaim),
          })
        ).status,
      ).toBe(404);
      const usage = run.requests.find((request) => {
        return request.path.endsWith("/pi-memory-phase2/usage");
      });
      if (!usage) {
        throw new Error("Missing actual private usage report");
      }
      for (let retry = 0; retry < 2; retry++) {
        expect(
          (
            await run.app.request(usage.path, {
              method: "POST",
              headers: {
                authorization: `Bearer ${run.token}`,
                "content-type": "application/json",
              },
              body: usage.body,
            })
          ).status,
        ).toBe(200);
      }
      const replayUsage = await db()
        .select()
        .from(usageEvent)
        .where(eq(usageEvent.orgId, run.scope.orgId));
      const accounting = (rows: typeof replayUsage) =>
        {return rows
          .map(({ idempotencyKey, quantity, category, runId }) => {return {
            idempotencyKey,
            quantity,
            category,
            runId,
          }})
          .sort((left, right) =>
            {return left.idempotencyKey.localeCompare(right.idempotencyKey)},
          )};
      expect(accounting(replayUsage)).toStrictEqual(accounting(run.usage));

      await expect(
        db()
          .select()
          .from(storageVersionLineage)
          .where(eq(storageVersionLineage.runId, run.runId)),
      ).resolves.toHaveLength(1);
    },
  );

  it("settles real early no-diff without public session events or a provider", async () => {
    const run = await launch("none", true);
    expect(run.job, run.output).toMatchObject({
      completedRevision: 1,
      lastMaintenanceOutcome: "no_diff",
    });
    expect(run.providerCount).toBe(0);
    expect(run.usage).toHaveLength(0);
    expect(run.receipts).toHaveLength(1);
    expect(run.lineage).toHaveLength(0);
    expect(run.checkpointRows).toHaveLength(1);
  });

  it.each(["provider", "abrupt", "revoked", "invalid_marker"] as const)(
    "recovers the exact parent without publishing after %s",
    async (fault) => {
      const run = await launch(fault);
      if (fault === "revoked" || fault === "invalid_marker") {
        // Guest leaves checkpoint failure terminal reporting to Runner's
        // existing fallback. Exercise that same authenticated completion wire.
        const terminal = await run.app.request("/api/webhooks/agent/complete", {
          method: "POST",
          headers: {
            authorization: `Bearer ${run.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: run.runId,
            exitCode: 1,
            error: "Guest checkpoint failed",
          }),
        });
        expect(terminal.status, run.output).toBe(200);
      } else {
        expect(run.run?.status, run.output).toBe("failed");
      }
      expect(run.receipts).toHaveLength(0);
      expect(run.lineage).toHaveLength(0);
      expect(run.usage.length).toBeGreaterThan(0);
      expect(
        run.usage.every((entry) => {
          return entry.runId === null;
        }),
      ).toBeTruthy();
      const [storage] = await db()
        .select()
        .from(storages)
        .where(eq(storages.id, run.scope.memoryStorageId));
      expect(storage?.headVersionId).toBe(run.scope.baseVersion.versionId);
      const callback = {
        runId: run.runId,
        payload: run.binding,
        status: "failed" as const,
        error: "provider failure",
      };
      await handlePiMemoryPhase2MaintenanceCallback(db(), callback);
      await handlePiMemoryPhase2MaintenanceCallback(db(), callback);
      if (fault !== "revoked") {
        await expect(readPhase2Job(run.scope)).resolves.toMatchObject({
          retryCount: 1,
          lastMaintenanceOutcome: "failed",
        });
      } else {
        await expect(readPhase2Job(run.scope)).resolves.toMatchObject({
          retryCount: 0,
          completedRevision: 0,
        });
      }
    },
  );
});

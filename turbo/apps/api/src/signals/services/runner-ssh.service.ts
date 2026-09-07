import {
  sshHostKeySchema,
  type RunnerSshResolveRequest,
  type RunnerSshResolveResponse,
  type RunnerSshPinRequest,
  type RunnerSshPinResponse,
} from "@okouai/api-contracts/contracts/runner-ssh";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isStaffOrg } from "@okouai/core/staff-org";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentSshAccess } from "@okouai/db/schema/agent-ssh-access";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshConnectionCredentials } from "@okouai/db/schema/ssh-connection-credential";
import { and, eq, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import { decryptStoredSecretValue } from "./crypto.utils";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

type SshResolveInput = RunnerSshResolveRequest & { readonly runId: string };
type SshPinInput = RunnerSshPinRequest & { readonly runId: string };
const unavailable = Object.freeze({ outcome: "unavailable" as const });

async function currentConnection(
  db: Pick<Db, "select">,
  input: SshResolveInput,
  lockAuthority: boolean,
  signal: AbortSignal,
) {
  const query = db
    .select({
      id: sshConnections.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      host: sshConnections.host,
      port: sshConnections.port,
      username: sshConnections.username,
      generation: sshConnections.generation,
      algorithm: sshConnections.learnedHostKeyAlgorithm,
      fingerprint: sshConnections.learnedHostKeyFingerprint,
      encryptedPrivateKey: sshConnectionCredentials.encryptedPrivateKey,
      encryptedPassphrase: sshConnectionCredentials.encryptedPassphrase,
    })
    .from(agentRuns)
    .innerJoin(
      agentSessions,
      and(
        eq(agentSessions.id, agentRuns.sessionId),
        eq(agentSessions.orgId, agentRuns.orgId),
        eq(agentSessions.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      agents,
      and(
        eq(agents.id, agentSessions.agentId),
        eq(agents.orgId, agentRuns.orgId),
        eq(agents.owner, agentRuns.userId),
      ),
    )
    .innerJoin(
      agentSshAccess,
      and(
        eq(agentSshAccess.agentId, agents.id),
        eq(agentSshAccess.orgId, agentRuns.orgId),
        eq(agentSshAccess.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      sshConnections,
      and(
        eq(sshConnections.id, input.connectionId),
        eq(sshConnections.orgId, agentRuns.orgId),
        eq(sshConnections.userId, agentRuns.userId),
      ),
    )
    .innerJoin(
      sshConnectionCredentials,
      eq(sshConnectionCredentials.connectionId, sshConnections.id),
    )
    .where(
      and(
        eq(agentRuns.id, input.runId),
        eq(agentRuns.status, "running"),
        eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
        eq(
          agentRuns.runnerHeartbeatGeneration,
          input.runnerIdentity.heartbeatGeneration,
        ),
      ),
    );
  const [row] = lockAuthority
    ? await query.for("share", {
        of: [
          agentRuns,
          agentSessions,
          agents,
          agentSshAccess,
          sshConnectionCredentials,
        ],
      })
    : await query;
  signal.throwIfAborted();
  if (!row || !isStaffOrg(row.orgId)) {
    return null;
  }
  const featureContext = await loadUserFeatureSwitchContext(
    db,
    row.orgId,
    row.userId,
  );
  signal.throwIfAborted();
  return isFeatureEnabled(FeatureSwitchKey.SshAccess, featureContext)
    ? row
    : null;
}

function learnedHostKey(row: {
  readonly algorithm: string | null;
  readonly fingerprint: string | null;
}) {
  if (row.algorithm === null && row.fingerprint === null) {
    return null;
  }
  return sshHostKeySchema.parse({
    algorithm: row.algorithm,
    fingerprint: row.fingerprint,
  });
}

export async function resolveRunnerSsh(
  db: Pick<Db, "select">,
  input: SshResolveInput,
  signal: AbortSignal,
): Promise<RunnerSshResolveResponse> {
  const row = await currentConnection(db, input, false, signal);
  if (!row) {
    return unavailable;
  }
  const hostKey = learnedHostKey(row);
  // The joined snapshot is the authority handoff. Never hold DB locks across KMS.
  const privateKey = await decryptStoredSecretValue(row.encryptedPrivateKey);
  signal.throwIfAborted();
  const passphrase =
    row.encryptedPassphrase === null
      ? null
      : await decryptStoredSecretValue(row.encryptedPassphrase);
  signal.throwIfAborted();
  return {
    outcome: "resolved",
    host: row.host,
    port: row.port,
    username: row.username,
    generation: row.generation,
    learnedHostKey: hostKey,
    privateKey,
    passphrase,
  };
}

export async function pinRunnerSsh(
  db: Db,
  input: SshPinInput,
  signal: AbortSignal,
): Promise<RunnerSshPinResponse> {
  const initial = await currentConnection(db, input, false, signal);
  if (!initial) {
    return unavailable;
  }
  return await db.transaction(async (tx) => {
    // Same row as owner edit/reset, scoped only after non-locking authorization.
    const [locked] = await tx
      .select({ id: sshConnections.id })
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.id, initial.id),
          eq(sshConnections.orgId, initial.orgId),
          eq(sshConnections.userId, initial.userId),
        ),
      )
      .for("update");
    signal.throwIfAborted();
    if (!locked) {
      return unavailable;
    }
    const row = await currentConnection(tx, input, true, signal);
    if (!row) {
      return unavailable;
    }
    const existing = learnedHostKey(row);
    if (existing) {
      if (
        existing.algorithm !== input.observedHostKey.algorithm ||
        existing.fingerprint !== input.observedHostKey.fingerprint
      ) {
        return { outcome: "host_key_mismatch" };
      }
      return row.generation === input.expectedGeneration + 1
        ? { outcome: "matched", generation: row.generation }
        : { outcome: "configuration_changed" };
    }
    if (
      row.generation !== input.expectedGeneration ||
      row.generation === 2_147_483_647
    ) {
      return { outcome: "configuration_changed" };
    }
    await tx
      .update(sshConnections)
      .set({
        learnedHostKeyAlgorithm: input.observedHostKey.algorithm,
        learnedHostKeyFingerprint: input.observedHostKey.fingerprint,
        generation: sql`${sshConnections.generation} + 1`,
        updatedAt: nowDate(),
      })
      .where(eq(sshConnections.id, row.id));
    signal.throwIfAborted();
    return { outcome: "pinned", generation: row.generation + 1 };
  });
}

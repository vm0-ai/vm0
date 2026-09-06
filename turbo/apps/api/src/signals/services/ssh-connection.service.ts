import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import {
  SSH_CONNECTION_LIMIT,
  type CreateSshConnectionRequest,
  type SshConnectionResponse,
  type UpdateSshConnectionRequest,
} from "@okouai/api-contracts/contracts/ssh-connections";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { sshConnectionCredentials } from "@okouai/db/schema/ssh-connection-credential";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { and, asc, count, eq, ne, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";

type SshConnectionRow = typeof sshConnections.$inferSelect;
type SshConnectionFailure = {
  readonly kind: "bad_request" | "not_found" | "conflict";
  readonly message: string;
};
type SshConnectionResult<T> =
  | { readonly ok: true; readonly value: T }
  | ({ readonly ok: false } & SshConnectionFailure);

const SSH_CONNECTION_NOT_FOUND = "SSH connection not found";
const SSH_CONNECTION_GENERATION_CONFLICT =
  "SSH connection was modified by another request";
const SSH_CONNECTION_ENDPOINT_CONFLICT =
  "An SSH connection for this host and port already exists";
const SSH_CONNECTION_LIMIT_CONFLICT = `SSH connection limit of ${SSH_CONNECTION_LIMIT} reached`;

function failure(
  kind: SshConnectionFailure["kind"],
  message: string,
): SshConnectionResult<never> {
  return { ok: false, kind, message };
}

function canonicalizeIpv6(host: string): string {
  const parsed = new URL(`http://[${host}]`);
  return parsed.hostname.slice(1, -1);
}

function containsWhitespaceOrControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codeUnit = character.charCodeAt(0);
    return /\s/u.test(character) || codeUnit <= 0x1f || codeUnit === 0x7f;
  });
}

function canonicalizeSshHost(host: string): SshConnectionResult<string> {
  const trimmed = host.trim();
  const withoutRootDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (
    withoutRootDot.length === 0 ||
    withoutRootDot.length > 253 ||
    containsWhitespaceOrControl(withoutRootDot) ||
    withoutRootDot.includes("[") ||
    withoutRootDot.includes("]") ||
    withoutRootDot.includes("://")
  ) {
    return failure("bad_request", "Invalid SSH host");
  }

  const ipVersion = isIP(withoutRootDot);
  if (ipVersion === 4) {
    return { ok: true, value: withoutRootDot };
  }
  if (ipVersion === 6) {
    return { ok: true, value: canonicalizeIpv6(withoutRootDot) };
  }

  const ascii = domainToASCII(withoutRootDot).toLowerCase();
  if (ascii.length === 0 || ascii.length > 253) {
    return failure("bad_request", "Invalid SSH host");
  }

  const labels = ascii.split(".");
  if (
    labels.every((label) => {
      return /^\d+$/u.test(label);
    }) ||
    labels.some((label) => {
      return (
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
      );
    })
  ) {
    return failure("bad_request", "Invalid SSH host");
  }

  return { ok: true, value: ascii };
}

function toSshConnectionResponse(row: SshConnectionRow): SshConnectionResponse {
  const hasAlgorithm = row.learnedHostKeyAlgorithm !== null;
  const hasFingerprint = row.learnedHostKeyFingerprint !== null;
  if (hasAlgorithm !== hasFingerprint) {
    throw new Error("SSH connection has an incomplete learned host-key pair");
  }

  return {
    id: row.id,
    displayName: row.displayName,
    host: row.host,
    port: row.port,
    username: row.username,
    generation: row.generation,
    learnedHostKey:
      row.learnedHostKeyAlgorithm === null ||
      row.learnedHostKeyFingerprint === null
        ? null
        : {
            algorithm: row.learnedHostKeyAlgorithm,
            fingerprint: row.learnedHostKeyFingerprint,
          },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type WriteTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function lockSshConnectionOwner(
  tx: Pick<WriteTransaction, "execute">,
  orgId: string,
  userId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ssh_connection_owner:${orgId}:${userId}`}, 0))`,
  );
}

async function findOwnerConnection(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectionId: string;
  },
): Promise<SshConnectionRow | undefined> {
  const [row] = await db
    .select()
    .from(sshConnections)
    .where(
      and(
        eq(sshConnections.id, args.connectionId),
        eq(sshConnections.orgId, args.orgId),
        eq(sshConnections.userId, args.userId),
      ),
    )
    .limit(1);
  return row;
}

async function endpointExists(
  db: Pick<ReadonlyDb, "select">,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly host: string;
    readonly port: number;
    readonly exceptConnectionId?: string;
  },
): Promise<boolean> {
  const filters = [
    eq(sshConnections.orgId, args.orgId),
    eq(sshConnections.userId, args.userId),
    eq(sshConnections.host, args.host),
    eq(sshConnections.port, args.port),
  ];
  if (args.exceptConnectionId !== undefined) {
    filters.push(ne(sshConnections.id, args.exceptConnectionId));
  }
  const [row] = await db
    .select({ id: sshConnections.id })
    .from(sshConnections)
    .where(and(...filters))
    .limit(1);
  return row !== undefined;
}

async function countOwnerConnections(
  db: Pick<ReadonlyDb, "select">,
  orgId: string,
  userId: string,
): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(sshConnections)
    .where(
      and(eq(sshConnections.orgId, orgId), eq(sshConnections.userId, userId)),
    );
  if (!result) {
    throw new Error("SSH connection count query returned no row");
  }
  return result.value;
}

export async function listSshConnections(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<readonly SshConnectionResponse[]> {
  const rows = await db
    .select()
    .from(sshConnections)
    .where(
      and(eq(sshConnections.orgId, orgId), eq(sshConnections.userId, userId)),
    )
    .orderBy(asc(sshConnections.createdAt), asc(sshConnections.id));
  return rows.map(toSshConnectionResponse);
}

export async function summarizeSshConnections(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<{ readonly configuredCount: number; readonly limit: 64 }> {
  return {
    configuredCount: await countOwnerConnections(db, orgId, userId),
    limit: SSH_CONNECTION_LIMIT,
  };
}

export async function createSshConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly body: CreateSshConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<SshConnectionResult<SshConnectionResponse>> {
  const canonicalHost = canonicalizeSshHost(args.body.host);
  if (!canonicalHost.ok) {
    return canonicalHost;
  }

  const [duplicate, configuredCount] = await Promise.all([
    endpointExists(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      host: canonicalHost.value,
      port: args.body.port,
    }),
    countOwnerConnections(args.db, args.orgId, args.userId),
  ]);
  if (duplicate) {
    return failure("conflict", SSH_CONNECTION_ENDPOINT_CONFLICT);
  }
  if (configuredCount >= SSH_CONNECTION_LIMIT) {
    return failure("conflict", SSH_CONNECTION_LIMIT_CONFLICT);
  }

  const encryptedPrivateKey = await encryptStoredSecretValue(
    args.body.privateKey,
    args.featureContext,
  );
  const encryptedPassphrase =
    args.body.passphrase === null
      ? null
      : await encryptStoredSecretValue(
          args.body.passphrase,
          args.featureContext,
        );

  return await args.db.transaction(async (tx) => {
    await lockSshConnectionOwner(tx, args.orgId, args.userId);
    if (
      await endpointExists(tx, {
        orgId: args.orgId,
        userId: args.userId,
        host: canonicalHost.value,
        port: args.body.port,
      })
    ) {
      return failure("conflict", SSH_CONNECTION_ENDPOINT_CONFLICT);
    }
    if (
      (await countOwnerConnections(tx, args.orgId, args.userId)) >=
      SSH_CONNECTION_LIMIT
    ) {
      return failure("conflict", SSH_CONNECTION_LIMIT_CONFLICT);
    }

    const [connection] = await tx
      .insert(sshConnections)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        displayName: args.body.displayName,
        host: canonicalHost.value,
        port: args.body.port,
        username: args.body.username,
      })
      .returning();
    if (!connection) {
      throw new Error("SSH connection insert returned no row");
    }
    await tx.insert(sshConnectionCredentials).values({
      connectionId: connection.id,
      encryptedPrivateKey,
      encryptedPassphrase,
    });
    return { ok: true, value: toSshConnectionResponse(connection) };
  });
}

export async function updateSshConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly body: UpdateSshConnectionRequest;
  readonly featureContext: FeatureSwitchContext;
}): Promise<SshConnectionResult<SshConnectionResponse>> {
  const canonicalHost =
    args.body.host === undefined
      ? undefined
      : canonicalizeSshHost(args.body.host);
  if (canonicalHost !== undefined && !canonicalHost.ok) {
    return canonicalHost;
  }

  const preflight = await findOwnerConnection(args.db, args);
  if (!preflight) {
    return failure("not_found", SSH_CONNECTION_NOT_FOUND);
  }
  if (preflight.generation !== args.body.expectedGeneration) {
    return failure("conflict", SSH_CONNECTION_GENERATION_CONFLICT);
  }
  const preflightHost = canonicalHost?.value ?? preflight.host;
  const preflightPort = args.body.port ?? preflight.port;
  if (
    await endpointExists(args.db, {
      orgId: args.orgId,
      userId: args.userId,
      host: preflightHost,
      port: preflightPort,
      exceptConnectionId: args.connectionId,
    })
  ) {
    return failure("conflict", SSH_CONNECTION_ENDPOINT_CONFLICT);
  }

  const encryptedCredentials =
    args.body.credentials === undefined
      ? undefined
      : {
          encryptedPrivateKey: await encryptStoredSecretValue(
            args.body.credentials.privateKey,
            args.featureContext,
          ),
          encryptedPassphrase:
            args.body.credentials.passphrase === null
              ? null
              : await encryptStoredSecretValue(
                  args.body.credentials.passphrase,
                  args.featureContext,
                ),
        };

  return await args.db.transaction(async (tx) => {
    await lockSshConnectionOwner(tx, args.orgId, args.userId);
    const [current] = await tx
      .select()
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.id, args.connectionId),
          eq(sshConnections.orgId, args.orgId),
          eq(sshConnections.userId, args.userId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) {
      return failure("not_found", SSH_CONNECTION_NOT_FOUND);
    }
    if (current.generation !== args.body.expectedGeneration) {
      return failure("conflict", SSH_CONNECTION_GENERATION_CONFLICT);
    }

    const host = canonicalHost?.value ?? current.host;
    const port = args.body.port ?? current.port;
    if (
      await endpointExists(tx, {
        orgId: args.orgId,
        userId: args.userId,
        host,
        port,
        exceptConnectionId: args.connectionId,
      })
    ) {
      return failure("conflict", SSH_CONNECTION_ENDPOINT_CONFLICT);
    }

    const endpointChanged = host !== current.host || port !== current.port;
    const [updated] = await tx
      .update(sshConnections)
      .set({
        displayName: args.body.displayName,
        host,
        port,
        username: args.body.username,
        learnedHostKeyAlgorithm: endpointChanged
          ? null
          : current.learnedHostKeyAlgorithm,
        learnedHostKeyFingerprint: endpointChanged
          ? null
          : current.learnedHostKeyFingerprint,
        generation: sql`${sshConnections.generation} + 1`,
        updatedAt: nowDate(),
      })
      .where(eq(sshConnections.id, current.id))
      .returning();
    if (!updated) {
      throw new Error("SSH connection update returned no row");
    }

    if (encryptedCredentials !== undefined) {
      const [credential] = await tx
        .update(sshConnectionCredentials)
        .set({ ...encryptedCredentials, updatedAt: nowDate() })
        .where(eq(sshConnectionCredentials.connectionId, current.id))
        .returning({ connectionId: sshConnectionCredentials.connectionId });
      if (!credential) {
        throw new Error("SSH connection credential row is missing");
      }
    }
    return { ok: true, value: toSshConnectionResponse(updated) };
  });
}

export async function deleteSshConnection(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
}): Promise<SshConnectionResult<undefined>> {
  return await args.db.transaction(async (tx) => {
    await lockSshConnectionOwner(tx, args.orgId, args.userId);
    const [deleted] = await tx
      .delete(sshConnections)
      .where(
        and(
          eq(sshConnections.id, args.connectionId),
          eq(sshConnections.orgId, args.orgId),
          eq(sshConnections.userId, args.userId),
        ),
      )
      .returning({ id: sshConnections.id });
    if (!deleted) {
      return failure("not_found", SSH_CONNECTION_NOT_FOUND);
    }
    return { ok: true, value: undefined };
  });
}

export async function resetSshConnectionHostKey(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly expectedGeneration: number;
}): Promise<SshConnectionResult<SshConnectionResponse>> {
  return await args.db.transaction(async (tx) => {
    await lockSshConnectionOwner(tx, args.orgId, args.userId);
    const [current] = await tx
      .select()
      .from(sshConnections)
      .where(
        and(
          eq(sshConnections.id, args.connectionId),
          eq(sshConnections.orgId, args.orgId),
          eq(sshConnections.userId, args.userId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) {
      return failure("not_found", SSH_CONNECTION_NOT_FOUND);
    }
    if (current.generation !== args.expectedGeneration) {
      return failure("conflict", SSH_CONNECTION_GENERATION_CONFLICT);
    }

    const [updated] = await tx
      .update(sshConnections)
      .set({
        learnedHostKeyAlgorithm: null,
        learnedHostKeyFingerprint: null,
        generation: sql`${sshConnections.generation} + 1`,
        updatedAt: nowDate(),
      })
      .where(eq(sshConnections.id, current.id))
      .returning();
    if (!updated) {
      throw new Error("SSH host-key reset returned no row");
    }
    return { ok: true, value: toSshConnectionResponse(updated) };
  });
}

export async function matchSshConnectionCredentials(args: {
  readonly db: ReadonlyDb;
  readonly orgId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly privateKey: string;
  readonly passphrase: string | null;
}): Promise<
  | {
      readonly privateKeyMatches: boolean;
      readonly passphraseMatches: boolean;
    }
  | undefined
> {
  const connection = await findOwnerConnection(args.db, args);
  if (!connection) {
    return undefined;
  }

  const [credential] = await args.db
    .select({
      encryptedPrivateKey: sshConnectionCredentials.encryptedPrivateKey,
      encryptedPassphrase: sshConnectionCredentials.encryptedPassphrase,
    })
    .from(sshConnectionCredentials)
    .where(eq(sshConnectionCredentials.connectionId, args.connectionId))
    .limit(1);
  if (!credential) {
    throw new Error("SSH connection credential row is missing");
  }

  const privateKey = await decryptStoredSecretValue(
    credential.encryptedPrivateKey,
  );
  const passphrase =
    credential.encryptedPassphrase === null
      ? null
      : await decryptStoredSecretValue(credential.encryptedPassphrase);
  return {
    privateKeyMatches: privateKey === args.privateKey,
    passphraseMatches: passphrase === args.passphrase,
  };
}

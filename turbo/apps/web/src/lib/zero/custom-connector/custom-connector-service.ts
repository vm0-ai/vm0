import { eq, and } from "drizzle-orm";
import {
  getAllBuiltinConnectorHosts,
  getBuiltinConnectorDisplayName,
} from "@vm0/core/firewalls";
import { orgCustomConnectors } from "../../../db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "../../../db/schema/org-custom-connector-secret";
import { encryptSecretValue } from "../../shared/crypto";
import { badRequest, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";

const log = logger("service:custom-connector");

/**
 * Placeholder used in header templates — replaced at runtime with the
 * calling user's secret. This keeps the stored template free of any
 * engine-specific syntax leaking out of the service layer.
 */
export const SECRET_PLACEHOLDER = "{{secret}}";

/**
 * Slug format — URL-safe, aligns with existing connector type identifiers
 * so it can be used as the firewall `ref` without extra mapping.
 */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const HEADER_NAME_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;

interface CustomConnectorInput {
  displayName: string;
  prefixes: string[];
  headerName: string;
  headerTemplate: string;
  slug?: string;
}

interface CustomConnector {
  id: string;
  orgId: string;
  slug: string;
  displayName: string;
  prefixes: string[];
  headerName: string;
  headerTemplate: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function normalizePrefix(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw badRequest(`Invalid prefix URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw badRequest(`Prefix must use https://: ${raw}`);
  }
  if (url.search || url.hash) {
    throw badRequest(`Prefix must not contain query or fragment: ${raw}`);
  }
  const pathname = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  return `${url.origin}${pathname}`;
}

function hostSlugFromPrefix(prefix: string): string {
  const host = new URL(prefix).host.toLowerCase();
  return host
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function randomShortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function validateInput(input: CustomConnectorInput): {
  displayName: string;
  prefixes: string[];
  headerName: string;
  headerTemplate: string;
  slug?: string;
} {
  const displayName = input.displayName.trim();
  if (displayName.length < 1 || displayName.length > 128) {
    throw badRequest("Display name must be between 1 and 128 characters");
  }
  if (!Array.isArray(input.prefixes) || input.prefixes.length === 0) {
    throw badRequest("At least one prefix is required");
  }
  const prefixes = input.prefixes.map(normalizePrefix);
  const seen = new Set<string>();
  for (const p of prefixes) {
    if (seen.has(p)) throw badRequest(`Duplicate prefix: ${p}`);
    seen.add(p);
  }
  // Reject prefixes whose host collides with a built-in connector. Mitm-level
  // matching is still the final line of defense; this early rejection gives
  // admins a clear message at create time instead of a silent shadow.
  const builtinHosts = getAllBuiltinConnectorHosts();
  for (const p of prefixes) {
    const host = new URL(p).host;
    const builtinType = builtinHosts.get(host);
    if (builtinType) {
      throw badRequest(
        `Host "${host}" is already managed by the ${getBuiltinConnectorDisplayName(
          builtinType,
        )} connector`,
      );
    }
  }
  const headerName = input.headerName.trim();
  if (!HEADER_NAME_REGEX.test(headerName)) {
    throw badRequest(
      "Header name must start with a letter and contain only letters, digits, and hyphens",
    );
  }
  if (!input.headerTemplate.includes(SECRET_PLACEHOLDER)) {
    throw badRequest(
      `Header template must contain the ${SECRET_PLACEHOLDER} placeholder`,
    );
  }
  const slug = input.slug?.trim();
  if (slug !== undefined && slug.length > 0 && !SLUG_REGEX.test(slug)) {
    throw badRequest(
      "Slug must be 3-64 chars, lowercase alphanumeric, and may contain internal hyphens",
    );
  }
  return {
    displayName,
    prefixes,
    headerName,
    headerTemplate: input.headerTemplate,
    slug,
  };
}

async function listCustomConnectors(orgId: string): Promise<CustomConnector[]> {
  const rows = await globalThis.services.db
    .select()
    .from(orgCustomConnectors)
    .where(eq(orgCustomConnectors.orgId, orgId))
    .orderBy(orgCustomConnectors.slug);
  return rows.map((r) => {
    return { ...r, prefixes: r.prefixes as string[] };
  });
}

async function getCustomConnector(
  orgId: string,
  id: string,
): Promise<CustomConnector> {
  const [row] = await globalThis.services.db
    .select()
    .from(orgCustomConnectors)
    .where(
      and(eq(orgCustomConnectors.id, id), eq(orgCustomConnectors.orgId, orgId)),
    )
    .limit(1);
  if (!row) {
    throw notFound(`Custom connector ${id} not found`);
  }
  return { ...row, prefixes: row.prefixes as string[] };
}

export async function createCustomConnector(
  orgId: string,
  userId: string,
  input: CustomConnectorInput,
): Promise<CustomConnector> {
  const v = validateInput(input);
  const slug =
    v.slug ?? `${hostSlugFromPrefix(v.prefixes[0]!)}-${randomShortId()}`;
  log.debug("creating custom connector", { orgId, slug });
  const [row] = await globalThis.services.db
    .insert(orgCustomConnectors)
    .values({
      orgId,
      slug,
      displayName: v.displayName,
      prefixes: v.prefixes,
      headerName: v.headerName,
      headerTemplate: v.headerTemplate,
      createdBy: userId,
    })
    .returning();
  if (!row) {
    throw new Error("Expected insert to return a row");
  }
  return { ...row, prefixes: row.prefixes as string[] };
}

export async function patchCustomConnectorDisplayName(
  orgId: string,
  id: string,
  displayName: string,
): Promise<CustomConnector> {
  const trimmed = displayName.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw badRequest("Display name must be between 1 and 128 characters");
  }
  const [row] = await globalThis.services.db
    .update(orgCustomConnectors)
    .set({ displayName: trimmed, updatedAt: new Date() })
    .where(
      and(eq(orgCustomConnectors.id, id), eq(orgCustomConnectors.orgId, orgId)),
    )
    .returning();
  if (!row) {
    throw notFound(`Custom connector ${id} not found`);
  }
  return { ...row, prefixes: row.prefixes as string[] };
}

export async function deleteCustomConnector(
  orgId: string,
  id: string,
): Promise<void> {
  await globalThis.services.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: orgCustomConnectors.id })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, id),
          eq(orgCustomConnectors.orgId, orgId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw notFound(`Custom connector ${id} not found`);
    }
    await tx
      .delete(orgCustomConnectorSecrets)
      .where(eq(orgCustomConnectorSecrets.connectorId, id));
    await tx.delete(orgCustomConnectors).where(eq(orgCustomConnectors.id, id));
  });
  log.debug("custom connector deleted", { orgId, id });
}

export async function setCustomConnectorSecret(
  orgId: string,
  userId: string,
  connectorId: string,
  value: string,
): Promise<void> {
  if (value.length === 0) {
    throw badRequest("Secret value must not be empty");
  }
  // Ensure the connector belongs to the user's org — prevents writing secrets
  // against connectors in other orgs even if the id is guessed.
  await getCustomConnector(orgId, connectorId);

  const key = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedValue = encryptSecretValue(value, key);
  await globalThis.services.db
    .insert(orgCustomConnectorSecrets)
    .values({ connectorId, userId, orgId, encryptedValue })
    .onConflictDoUpdate({
      target: [
        orgCustomConnectorSecrets.connectorId,
        orgCustomConnectorSecrets.userId,
      ],
      set: { encryptedValue, updatedAt: new Date() },
    });
}

export async function deleteCustomConnectorSecret(
  orgId: string,
  userId: string,
  connectorId: string,
): Promise<void> {
  await globalThis.services.db
    .delete(orgCustomConnectorSecrets)
    .where(
      and(
        eq(orgCustomConnectorSecrets.connectorId, connectorId),
        eq(orgCustomConnectorSecrets.userId, userId),
        eq(orgCustomConnectorSecrets.orgId, orgId),
      ),
    );
}

interface CustomConnectorWithSecretStatus extends CustomConnector {
  hasSecret: boolean;
}

export async function listCustomConnectorsWithSecretStatus(
  orgId: string,
  userId: string,
): Promise<CustomConnectorWithSecretStatus[]> {
  const connectorsList = await listCustomConnectors(orgId);
  if (connectorsList.length === 0) return [];
  const secretRows = await globalThis.services.db
    .select({ connectorId: orgCustomConnectorSecrets.connectorId })
    .from(orgCustomConnectorSecrets)
    .where(
      and(
        eq(orgCustomConnectorSecrets.orgId, orgId),
        eq(orgCustomConnectorSecrets.userId, userId),
      ),
    );
  const haveSecret = new Set(
    secretRows.map((r) => {
      return r.connectorId;
    }),
  );
  return connectorsList.map((c) => {
    return { ...c, hasSecret: haveSecret.has(c.id) };
  });
}

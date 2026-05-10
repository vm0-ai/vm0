import { command, computed, type Computed } from "ccstate";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getAllBuiltinConnectorHosts,
  getBuiltinConnectorDisplayName,
} from "@vm0/connectors/firewalls";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";

import { db$, writeDb$ } from "../external/db";
import { badRequestMessage, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { safeUrlParse } from "../utils";

const L = logger("CustomConnectorService");

const SECRET_PLACEHOLDER = "{{secret}}";
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const HEADER_NAME_REGEX = /^[A-Za-z][A-Za-z0-9-]*$/;

type BadRequestResponse = ReturnType<typeof badRequestMessage>;

export interface CustomConnectorRow {
  readonly id: string;
  readonly orgId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly prefixes: readonly string[];
  readonly headerName: string;
  readonly headerTemplate: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface CreateCustomConnectorInput {
  readonly displayName: string;
  readonly prefixes: readonly string[];
  readonly headerName: string;
  readonly headerTemplate: string;
  readonly slug?: string;
}

interface ValidatedInput {
  readonly displayName: string;
  readonly prefixes: readonly string[];
  readonly headerName: string;
  readonly headerTemplate: string;
  readonly slug: string | undefined;
}

function isBadRequest(value: unknown): value is BadRequestResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value as { status: unknown }).status === 400
  );
}

function normalizePrefix(raw: string): string | BadRequestResponse {
  const trimmed = raw.trim();
  const url = safeUrlParse(trimmed);
  if (!url) {
    return badRequestMessage(`Invalid prefix URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    return badRequestMessage(`Prefix must use https://: ${raw}`);
  }
  if (url.search || url.hash) {
    return badRequestMessage(
      `Prefix must not contain query or fragment: ${raw}`,
    );
  }
  const pathname = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  return `${url.origin}${pathname}`;
}

function hostSlugFromPrefix(prefix: string): string {
  // Safe: only called after normalizePrefix has verified the URL parses.
  const parsed = safeUrlParse(prefix);
  const host = (parsed?.host ?? "").toLowerCase();
  return host
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function randomShortId(): string {
  // crypto.randomUUID() yields a 32 hex-char string when dashes stripped;
  // first 6 chars are sufficient for a non-security-sensitive display
  // suffix on slugs (web uses Math.random; we prefer crypto for forward-compat).
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

export function validateDisplayName(raw: string): string | BadRequestResponse {
  const displayName = raw.trim();
  if (displayName.length < 1 || displayName.length > 128) {
    return badRequestMessage(
      "Display name must be between 1 and 128 characters",
    );
  }
  return displayName;
}

function validateAndNormalisePrefixes(
  raw: readonly string[],
): readonly string[] | BadRequestResponse {
  if (!Array.isArray(raw) || raw.length === 0) {
    return badRequestMessage("At least one prefix is required");
  }
  const normalised: string[] = [];
  for (const p of raw) {
    const result = normalizePrefix(p);
    if (isBadRequest(result)) {
      return result;
    }
    normalised.push(result);
  }
  const seen = new Set<string>();
  for (const p of normalised) {
    if (seen.has(p)) {
      return badRequestMessage(`Duplicate prefix: ${p}`);
    }
    seen.add(p);
  }
  // Reject prefixes whose host collides with a built-in connector. Mitm-level
  // matching is still the final line of defense; this early rejection gives
  // admins a clear message at create time instead of a silent shadow.
  const builtinHosts = getAllBuiltinConnectorHosts();
  for (const p of normalised) {
    const host = safeUrlParse(p)?.host ?? "";
    const builtinType = builtinHosts.get(host);
    if (builtinType) {
      return badRequestMessage(
        `Host "${host}" is already managed by the ${getBuiltinConnectorDisplayName(builtinType)} connector`,
      );
    }
  }
  return normalised;
}

function validateHeaderName(raw: string): string | BadRequestResponse {
  const headerName = raw.trim();
  if (!HEADER_NAME_REGEX.test(headerName)) {
    return badRequestMessage(
      "Header name must start with a letter and contain only letters, digits, and hyphens",
    );
  }
  return headerName;
}

function validateHeaderTemplate(raw: string): BadRequestResponse | null {
  if (!raw.includes(SECRET_PLACEHOLDER)) {
    return badRequestMessage(
      `Header template must contain the ${SECRET_PLACEHOLDER} placeholder`,
    );
  }
  return null;
}

function validateOptionalSlug(
  raw: string | undefined,
): string | undefined | BadRequestResponse {
  const slug = raw?.trim();
  if (slug === undefined || slug.length === 0) {
    return undefined;
  }
  if (!SLUG_REGEX.test(slug)) {
    return badRequestMessage(
      "Slug must be 3-64 chars, lowercase alphanumeric, and may contain internal hyphens",
    );
  }
  return slug;
}

function validateInput(
  input: CreateCustomConnectorInput,
): ValidatedInput | BadRequestResponse {
  const displayName = validateDisplayName(input.displayName);
  if (isBadRequest(displayName)) {
    return displayName;
  }
  const prefixes = validateAndNormalisePrefixes(input.prefixes);
  if (isBadRequest(prefixes)) {
    return prefixes;
  }
  const headerName = validateHeaderName(input.headerName);
  if (isBadRequest(headerName)) {
    return headerName;
  }
  const headerTemplateError = validateHeaderTemplate(input.headerTemplate);
  if (headerTemplateError) {
    return headerTemplateError;
  }
  const slug = validateOptionalSlug(input.slug);
  if (isBadRequest(slug)) {
    return slug;
  }
  return {
    displayName,
    prefixes,
    headerName,
    headerTemplate: input.headerTemplate,
    slug,
  };
}

export const createCustomConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly input: CreateCustomConnectorInput;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorRow | BadRequestResponse> => {
    const v = validateInput(args.input);
    if (isBadRequest(v)) {
      return v;
    }
    signal.throwIfAborted();

    const slug =
      v.slug ?? `${hostSlugFromPrefix(v.prefixes[0]!)}-${randomShortId()}`;
    L.debug("creating custom connector", { orgId: args.orgId, slug });

    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .insert(orgCustomConnectors)
      .values({
        orgId: args.orgId,
        slug,
        displayName: v.displayName,
        prefixes: [...v.prefixes],
        headerName: v.headerName,
        headerTemplate: v.headerTemplate,
        createdBy: args.userId,
      })
      .returning();
    signal.throwIfAborted();

    if (!row) {
      throw new Error("Expected insert to return a row");
    }

    // Drizzle types `prefixes` as `unknown` (jsonb column); the value at
    // runtime is the string[] we just inserted.
    return { ...row, prefixes: row.prefixes as readonly string[] };
  },
);

type NotFoundResponse = ReturnType<typeof notFound>;

export const deleteCustomConnector$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly id: string },
    signal: AbortSignal,
  ): Promise<NotFoundResponse | undefined> => {
    const writeDb = set(writeDb$);
    const deleted = await writeDb.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: orgCustomConnectors.id })
        .from(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.id, args.id),
            eq(orgCustomConnectors.orgId, args.orgId),
          ),
        )
        .limit(1);
      if (!existing) {
        return false;
      }
      await tx
        .delete(orgCustomConnectorSecrets)
        .where(eq(orgCustomConnectorSecrets.connectorId, args.id));
      await tx
        .delete(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.id, args.id),
            eq(orgCustomConnectors.orgId, args.orgId),
          ),
        );
      return true;
    });
    signal.throwIfAborted();
    if (!deleted) {
      return notFound("Custom connector not found");
    }
    L.debug("custom connector deleted", { orgId: args.orgId, id: args.id });
    return undefined;
  },
);

/**
 * Look up a custom connector by id, scoped to the caller's org so cross-org
 * ids return null. Reusable by every per-id mutation route in this family
 * (set-secret here, delete-secret + rename + delete in sibling PRs).
 */
export function getCustomConnectorById(args: {
  readonly orgId: string;
  readonly connectorId: string;
}): Computed<Promise<CustomConnectorRow | null>> {
  return computed(async (get): Promise<CustomConnectorRow | null> => {
    const db = get(db$);
    const [row] = await db
      .select()
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, args.connectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
        ),
      )
      .limit(1);
    if (!row) {
      return null;
    }
    return { ...row, prefixes: row.prefixes as readonly string[] };
  });
}

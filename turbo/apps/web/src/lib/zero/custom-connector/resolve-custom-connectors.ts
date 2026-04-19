import { eq, and, inArray } from "drizzle-orm";
import type { ExpandedFirewallConfig } from "@vm0/core";
import { orgCustomConnectors } from "../../../db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "../../../db/schema/org-custom-connector-secret";
import { decryptSecretValue } from "../../shared/crypto";
import { SECRET_PLACEHOLDER } from "./custom-connector-service";

interface ResolvedCustomConnectors {
  firewalls: ExpandedFirewallConfig[];
  secrets: Record<string, string>;
}

/**
 * Build a secret key for a custom connector secret.
 * Uses the connector UUID (hyphens stripped) so key names don't collide
 * with any user-defined secret (which must start with an uppercase letter
 * and contain only [A-Z0-9_]).
 */
function customSecretKey(connectorId: string): string {
  return `CUSTOM_${connectorId.replaceAll("-", "").toUpperCase()}`;
}

/**
 * Resolve all org custom connectors the user has a secret for, returning
 * a list of synthesized firewall configs plus the secret map entries they
 * reference. Connectors without a user secret are skipped entirely — the
 * mitm proxy never sees a rule for them.
 *
 * The synthesized firewalls use empty `permissions`, which combined with
 * the default `unknownPolicy: "allow"` means the entire base URL is
 * granted once the user has supplied a secret.
 *
 * @param allowedCustomIds If provided, restricts the result to connectors
 *   whose id appears in the list (per-agent authorization). `undefined`
 *   preserves the original behavior — every connector the user has a secret
 *   for is returned. An empty array returns no firewalls.
 */
export async function resolveCustomConnectorFirewalls(
  orgId: string,
  userId: string,
  allowedCustomIds?: string[],
): Promise<ResolvedCustomConnectors> {
  if (allowedCustomIds !== undefined && allowedCustomIds.length === 0) {
    return { firewalls: [], secrets: {} };
  }

  const rows = await globalThis.services.db
    .select({
      id: orgCustomConnectors.id,
      slug: orgCustomConnectors.slug,
      displayName: orgCustomConnectors.displayName,
      prefixes: orgCustomConnectors.prefixes,
      headerName: orgCustomConnectors.headerName,
      headerTemplate: orgCustomConnectors.headerTemplate,
      encryptedSecret: orgCustomConnectorSecrets.encryptedValue,
    })
    .from(orgCustomConnectors)
    .innerJoin(
      orgCustomConnectorSecrets,
      and(
        eq(orgCustomConnectorSecrets.connectorId, orgCustomConnectors.id),
        eq(orgCustomConnectorSecrets.userId, userId),
      ),
    )
    .where(
      allowedCustomIds
        ? and(
            eq(orgCustomConnectors.orgId, orgId),
            inArray(orgCustomConnectors.id, allowedCustomIds),
          )
        : eq(orgCustomConnectors.orgId, orgId),
    );

  if (rows.length === 0) {
    return { firewalls: [], secrets: {} };
  }

  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const firewalls: ExpandedFirewallConfig[] = [];
  const secrets: Record<string, string> = {};

  for (const row of rows) {
    const secretKey = customSecretKey(row.id);
    const resolvedTemplate = row.headerTemplate.replaceAll(
      SECRET_PLACEHOLDER,
      `\${{ secrets.${secretKey} }}`,
    );
    const prefixes = row.prefixes as string[];
    firewalls.push({
      name: row.slug,
      ref: row.slug,
      description: row.displayName,
      apis: prefixes.map((prefix) => {
        return {
          base: prefix,
          auth: {
            headers: { [row.headerName]: resolvedTemplate },
          },
        };
      }),
    });
    secrets[secretKey] = decryptSecretValue(row.encryptedSecret, encryptionKey);
  }

  return { firewalls, secrets };
}

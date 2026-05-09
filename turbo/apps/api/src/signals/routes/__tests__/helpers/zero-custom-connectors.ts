import { randomUUID } from "node:crypto";

import { command } from "ccstate";
import { orgCustomConnectors } from "@vm0/db/schema/org-custom-connector";
import { orgCustomConnectorSecrets } from "@vm0/db/schema/org-custom-connector-secret";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../../../external/db";

export interface CustomConnectorFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
}

interface SeedValues {
  readonly slug?: string;
  readonly displayName?: string;
  readonly prefixes?: readonly string[];
  readonly headerName?: string;
  readonly headerTemplate?: string;
  readonly withSecret?: boolean;
}

export const seedCustomConnectorOrg$ = command(
  async (
    { set },
    values: SeedValues,
    signal: AbortSignal,
  ): Promise<CustomConnectorFixture> => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const connectorId = randomUUID();
    const writeDb = set(writeDb$);

    await writeDb.insert(orgCustomConnectors).values({
      id: connectorId,
      orgId,
      slug: values.slug ?? `connector-${connectorId.slice(0, 8)}`,
      displayName: values.displayName ?? "Example",
      prefixes: [...(values.prefixes ?? ["https://api.example.com/"])],
      headerName: values.headerName ?? "Authorization",
      headerTemplate: values.headerTemplate ?? "Bearer {{secret}}",
      createdBy: userId,
    });
    signal.throwIfAborted();

    if (values.withSecret) {
      await writeDb.insert(orgCustomConnectorSecrets).values({
        connectorId,
        userId,
        orgId,
        encryptedValue: "encrypted-test-secret",
      });
      signal.throwIfAborted();
    }

    return { orgId, userId, connectorId };
  },
);

export const deleteCustomConnectorOrg$ = command(
  async (
    { set },
    fixture: CustomConnectorFixture,
    signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgCustomConnectorSecrets)
      .where(eq(orgCustomConnectorSecrets.connectorId, fixture.connectorId));
    signal.throwIfAborted();
    await writeDb
      .delete(orgCustomConnectors)
      .where(eq(orgCustomConnectors.id, fixture.connectorId));
    signal.throwIfAborted();
  },
);

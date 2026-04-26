import { randomUUID } from "node:crypto";

import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { eq } from "drizzle-orm";

import { closeDbPool, getDb } from "../lib/db";

interface BuiltInModelsFixture {
  label: string;
  models: string[];
  vendor: string;
}

export function createBuiltInModelsFixture(): BuiltInModelsFixture {
  return {
    label: `api-test-${randomUUID()}`,
    models: [
      `api-test-model-${randomUUID()}`,
      `api-test-model-${randomUUID()}`,
    ],
    vendor: `vendor-${randomUUID()}`,
  };
}

export async function seedBuiltInModelsFixture(
  fixture: BuiltInModelsFixture,
): Promise<void> {
  await getDb()
    .insert(vm0ApiKeys)
    .values(
      fixture.models.map((model) => {
        return {
          apiKey: `api-test-key-${randomUUID()}`,
          label: fixture.label,
          model,
          vendor: fixture.vendor,
        };
      }),
    );
}

export async function deleteBuiltInModelsFixture(
  fixture: BuiltInModelsFixture,
): Promise<void> {
  await getDb().delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, fixture.label));
}

export async function closeFixtureDbPool(): Promise<void> {
  await closeDbPool();
}

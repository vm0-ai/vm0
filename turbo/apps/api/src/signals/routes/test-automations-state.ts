import {
  getProviderRuntimeModel,
  getVm0Vendor,
  MODEL_PROVIDER_TYPES,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { command } from "ccstate";
import { testAutomationsStateContract } from "@vm0/api-contracts/contracts/test-automations-state";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { bodyResultOf } from "../context/request";
import { request$ } from "../context/hono";
import { writeDb$, type Db } from "../external/db";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../../lib/secret-kms-client";
import { testOverride } from "../../lib/singleton";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

// Test-only support actions. The legacy automation seeding endpoints that
// used to live here were removed together with the automations tables
// (#20101); the remaining actions cover generic fixtures (composes, fake KMS,
// the vm0-managed default model key) still used by the API test suites.

const actionBody$ = bodyResultOf(testAutomationsStateContract.action);
const fakeKmsDataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");
const RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY =
  "vm0-key-run-lifecycle-bdd-default-model";
const fakeKmsDecryptCallCount = testOverride<number>(() => {
  return 0;
});

async function seedCompose(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly composeId?: string;
  },
): Promise<string> {
  const composeId = args.composeId ?? randomUUID();
  await db.insert(agentComposes).values({
    id: composeId,
    userId: args.userId,
    orgId: args.orgId,
    name: `agent-extra-${composeId.slice(0, 8)}`,
  });
  return composeId;
}

function fakeSecretKmsClient(): SecretKmsClient {
  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(
    command: GenerateDataKeyCommand | DecryptCommand,
  ): Promise<GenerateDataKeyCommandOutput | DecryptCommandOutput> {
    if (command instanceof GenerateDataKeyCommand) {
      return Promise.resolve({
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `encrypted-data-key:${command.input.KeyId}`,
          "utf8",
        ),
        Plaintext: fakeKmsDataKey,
      });
    }
    fakeKmsDecryptCallCount.set(fakeKmsDecryptCallCount.get() + 1);
    return Promise.resolve({ $metadata: {}, Plaintext: fakeKmsDataKey });
  }
  return { send };
}

async function readComposeHeadVersion(
  db: Db,
  composeId: string,
  signal: AbortSignal,
): Promise<string | null> {
  const [composeRow] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  signal.throwIfAborted();
  return composeRow?.headVersionId ?? null;
}

async function seedVm0ManagedDefaultModelKey(
  db: Db,
  signal: AbortSignal,
): Promise<string> {
  const selectedModel = MODEL_PROVIDER_TYPES.vm0.defaultModel;
  if (!selectedModel) {
    throw new Error("Expected vm0 to define a default model");
  }
  return await seedVm0ManagedModelKey(db, selectedModel, signal);
}

async function seedVm0ManagedModelKey(
  db: Db,
  selectedModel: string,
  signal: AbortSignal,
): Promise<string> {
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY));
  signal.throwIfAborted();
  await db.insert(vm0ApiKeys).values({
    vendor: getVm0Vendor(selectedModel),
    model: getProviderRuntimeModel("vm0", selectedModel),
    apiKey: RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY,
    label: "run-lifecycle-bdd",
  });
  signal.throwIfAborted();
  return selectedModel;
}

async function deleteVm0ManagedDefaultModelKey(
  db: Db,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(vm0ApiKeys)
    .where(eq(vm0ApiKeys.apiKey, RUN_LIFECYCLE_TEST_VM0_MANAGED_API_KEY));
  signal.throwIfAborted();
}

const postAutomationsStateAction$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const db = set(writeDb$);
    switch (body.action) {
      case "seed-compose": {
        const composeId = await seedCompose(db, {
          orgId: body.org_id,
          userId: body.user_id,
          composeId: body.compose_id,
        });
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: { ok: true as const, compose_id: composeId },
        };
      }
      case "read-compose-head-version": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            head_version_id: await readComposeHeadVersion(
              db,
              body.compose_id,
              signal,
            ),
          },
        };
      }
      case "seed-vm0-managed-default-model-key": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            selected_model: await seedVm0ManagedDefaultModelKey(db, signal),
          },
        };
      }
      case "seed-vm0-managed-model-key": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            selected_model: await seedVm0ManagedModelKey(
              db,
              body.selected_model,
              signal,
            ),
          },
        };
      }
      case "delete-vm0-managed-default-model-key": {
        await deleteVm0ManagedDefaultModelKey(db, signal);
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "enable-fake-kms": {
        fakeKmsDecryptCallCount.set(0);
        setSecretKmsClientForTests(fakeSecretKmsClient());
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "reset-fake-kms": {
        resetSecretKmsClientForTests();
        fakeKmsDecryptCallCount.set(0);
        return { status: 200 as const, body: { ok: true as const } };
      }
      case "read-fake-kms-state": {
        return {
          status: 200 as const,
          body: {
            ok: true as const,
            decrypt_call_count: fakeKmsDecryptCallCount.get(),
          },
        };
      }
    }
  },
);

export const testAutomationsStateRoutes: readonly RouteEntry[] = [
  {
    route: testAutomationsStateContract.action,
    handler: postAutomationsStateAction$,
  },
];

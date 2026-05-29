import { resetApiTestMocks } from "./mocks";
import {
  DecryptCommand,
  type DecryptCommandOutput,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import {
  type Dispatcher,
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
} from "undici";

import { clearMockedEnv, mockEnv } from "../lib/env";
import { clearMockNow } from "../lib/time";
import { server } from "../mocks/server";
import {
  resetSecretKmsClientForTests,
  setSecretKmsClientForTests,
  type SecretKmsClient,
} from "../signals/services/crypto.utils";
import { clearAllDetached } from "../signals/utils";

// msw's FetchInterceptor monkey-patches globalThis.fetch, so it does not see
// undici.request calls (used by the legacy fallthrough proxy in app-factory).
// Tests that need to stub upstream HTTP for undici.request use this MockAgent
// instead — installed lazily so msw-only tests pay no setup cost. The agent
// is recreated per test that calls useUndiciMock() to keep intercepts isolated.
const undiciState = (() => {
  let originalDispatcher: Dispatcher | undefined;
  let activeMock: MockAgent | undefined;
  return {
    get originalDispatcher(): Dispatcher | undefined {
      return originalDispatcher;
    },
    set originalDispatcher(v: Dispatcher | undefined) {
      originalDispatcher = v;
    },
    get activeMock(): MockAgent | undefined {
      return activeMock;
    },
    set activeMock(v: MockAgent | undefined) {
      activeMock = v;
    },
  };
})();

type MockKmsCommand = GenerateDataKeyCommand | DecryptCommand;
type MockKmsResponse = GenerateDataKeyCommandOutput | DecryptCommandOutput;

const testDataKey = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

function createApiTestKmsClient(): SecretKmsClient {
  function send(
    command: GenerateDataKeyCommand,
  ): Promise<GenerateDataKeyCommandOutput>;
  function send(command: DecryptCommand): Promise<DecryptCommandOutput>;
  function send(command: MockKmsCommand): Promise<MockKmsResponse> {
    if (command instanceof GenerateDataKeyCommand) {
      return Promise.resolve({
        $metadata: {},
        KeyId: command.input.KeyId,
        CiphertextBlob: Buffer.from(
          `encrypted-data-key:${command.input.KeyId}`,
          "utf8",
        ),
        Plaintext: testDataKey,
      });
    }

    return Promise.resolve({ $metadata: {}, Plaintext: testDataKey });
  }

  return { send };
}

export function useUndiciMock(): MockAgent {
  if (undiciState.activeMock) {
    return undiciState.activeMock;
  }
  if (!undiciState.originalDispatcher) {
    undiciState.originalDispatcher = getGlobalDispatcher();
  }
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  undiciState.activeMock = agent;
  return agent;
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

beforeEach(() => {
  mockEnv("SECRETS_KMS_KEY_ID", "alias/vm0-secrets-test");
  setSecretKmsClientForTests(createApiTestKmsClient());
});

afterEach(async () => {
  await clearAllDetached();
  clearMockNow();
  resetSecretKmsClientForTests();
  clearMockedEnv();
  resetApiTestMocks();
  server.resetHandlers();
  if (undiciState.activeMock && undiciState.originalDispatcher) {
    setGlobalDispatcher(undiciState.originalDispatcher);
    await undiciState.activeMock.close();
    undiciState.activeMock = undefined;
  }
});

afterAll(() => {
  server.close();
});

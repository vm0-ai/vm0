import { resetApiTestMocks } from "./mocks";
import { afterAll, afterEach, beforeAll } from "vitest";
import {
  type Dispatcher,
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
} from "undici";

import { clearMockedEnv } from "../lib/env";
import { clearMockNow } from "../lib/time";
import { server } from "../mocks/server";
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

afterEach(async () => {
  await clearAllDetached();
  clearMockNow();
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

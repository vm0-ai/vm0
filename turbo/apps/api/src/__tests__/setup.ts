import { resetApiTestMocks } from "./mocks";
import { afterAll, afterEach, beforeAll } from "vitest";

import { clearMockedEnv } from "../lib/env";
import { clearMockNow } from "../lib/time";
import { server } from "../mocks/server";
import { clearAllDetached } from "../signals/utils";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(async () => {
  await clearAllDetached();
  clearMockNow();
  clearMockedEnv();
  resetApiTestMocks();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

import { resetApiTestMocks } from "./mocks";
import { afterEach } from "vitest";

import { clearMockedEnv } from "../lib/env";
import { clearMockNow } from "../lib/time";
import { clearAllDetached } from "../signals/utils";

afterEach(async () => {
  await clearAllDetached();
  clearMockNow();
  clearMockedEnv();
  resetApiTestMocks();
});

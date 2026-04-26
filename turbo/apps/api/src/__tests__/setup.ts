import { afterEach } from "vitest";

import { clearMockedEnv } from "../lib/env";
import { clearAllDetached } from "../signals/utils";

afterEach(async () => {
  await clearAllDetached();
  clearMockedEnv();
});

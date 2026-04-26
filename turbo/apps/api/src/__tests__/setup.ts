import { afterEach } from "vitest";

import { clearAllDetached } from "../signals/utils";

afterEach(async () => {
  await clearAllDetached();
});

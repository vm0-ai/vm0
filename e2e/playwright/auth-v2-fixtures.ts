import { test as base } from "./fixtures";
import { AuthV2TestResources } from "./lib/auth-v2";

export { expect } from "./fixtures";

interface AuthV2Fixtures {
  readonly authV2Resources: AuthV2TestResources;
}

export const test = base.extend<AuthV2Fixtures>({
  authV2Resources: async ({}, use) => {
    const resources = new AuthV2TestResources();
    try {
      await use(resources);
    } finally {
      await resources.cleanup();
    }
  },
});

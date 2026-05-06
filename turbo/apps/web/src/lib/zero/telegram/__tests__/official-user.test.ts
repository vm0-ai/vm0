import { describe, expect, it, beforeEach } from "vitest";
import { testContext, uniqueId } from "../../../../__tests__/test-helpers";
import {
  createTestCompose,
  seedTestTelegramUserAgentPreference,
  setDefaultAgentByComposeId,
} from "../../../../__tests__/api-test-helpers";
import { resolveEffectiveTelegramComposeId } from "../official-user";

const context = testContext();

describe("official Telegram user agent preference", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("falls back to the org default agent when no preference exists", async () => {
    const user = await context.setupUser();
    const defaultCompose = await createTestCompose(uniqueId("agent"));
    await setDefaultAgentByComposeId(user.orgId, defaultCompose.composeId);

    await expect(
      resolveEffectiveTelegramComposeId(user.userId, user.orgId),
    ).resolves.toBe(defaultCompose.composeId);
  });

  it("uses the selected compose when it belongs to the user's org", async () => {
    const user = await context.setupUser();
    const defaultCompose = await createTestCompose(uniqueId("agent"));
    const selectedCompose = await createTestCompose(uniqueId("agent"));
    await setDefaultAgentByComposeId(user.orgId, defaultCompose.composeId);
    await seedTestTelegramUserAgentPreference({
      vm0UserId: user.userId,
      orgId: user.orgId,
      selectedComposeId: selectedCompose.composeId,
    });

    await expect(
      resolveEffectiveTelegramComposeId(user.userId, user.orgId),
    ).resolves.toBe(selectedCompose.composeId);
  });

  it("ignores a stale selected compose outside the user's org", async () => {
    const user = await context.setupUser();
    const defaultCompose = await createTestCompose(uniqueId("agent"));
    const otherOrgCompose = await context.createAgentCompose(user.userId, {
      name: uniqueId("other-agent"),
    });
    await setDefaultAgentByComposeId(user.orgId, defaultCompose.composeId);
    await seedTestTelegramUserAgentPreference({
      vm0UserId: user.userId,
      orgId: user.orgId,
      selectedComposeId: otherOrgCompose.id,
    });

    await expect(
      resolveEffectiveTelegramComposeId(user.userId, user.orgId),
    ).resolves.toBe(defaultCompose.composeId);
  });
});

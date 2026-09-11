import { beforeEach, describe, expect, it } from "vitest";

import { getApiTestMocks } from "../../../__tests__/mocks";
import type { TestContext } from "../../../__tests__/test-context";
import { clearMockedEnv, mockEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";

describe("Clerk user.created lifecycle integration", () => {
  const mocks = getApiTestMocks();
  const context: TestContext = {
    signal: new AbortController().signal,
    mocks,
    sessionHistoryBlobs: new Map(),
  };
  const webhooks = createWebhookCallbackApi(context);
  const userCreatedData = {
    id: "user_123",
    created_at: 1_757_600_000_000,
    first_name: "Scarlett",
    last_name: "Xie",
    primary_email_address_id: "idn_123",
    email_addresses: [
      {
        id: "idn_123",
        email_address: "scarlett@example.com",
      },
    ],
  };

  beforeEach(() => {
    clearMockedEnv();
    mockEnv("ENV", "development");
    mocks.resend.contactsCreate.mockReset();
    mocks.resend.contactsGet.mockReset();
    mocks.resend.contactsUpdate.mockReset();
    mocks.resend.eventsSend.mockReset();
  });

  async function userCreatedWebhook(data: unknown): Promise<void> {
    webhooks.configureClerkWebhookSecret();
    webhooks.verifyNextClerkWebhook({ type: "user.created", data });
    const response = await webhooks.requestClerkWebhook("{}", {}, [200]);
    expect(response.body).toBe("OK");
    await flushWaitUntilForTest();
  }

  it("does not emit a Resend event outside production", async () => {
    await userCreatedWebhook(userCreatedData);

    expect(mocks.resend.eventsSend).not.toHaveBeenCalled();
  });

  it("emits the Resend event after a production registration", async () => {
    mockEnv("ENV", "production");
    mocks.resend.contactsCreate.mockResolvedValue({
      data: { id: "contact_123" },
      error: null,
    });
    mocks.resend.eventsSend.mockResolvedValue({
      data: { object: "event", event: "user.created" },
      error: null,
    });

    await userCreatedWebhook(userCreatedData);

    expect(mocks.resend.contactsCreate).toHaveBeenCalledExactlyOnceWith({
      email: "scarlett@example.com",
      firstName: "Scarlett",
      lastName: "Xie",
    });
    expect(mocks.resend.eventsSend).toHaveBeenCalledExactlyOnceWith({
      event: "user.created",
      email: "scarlett@example.com",
      payload: {
        user_id: "user_123",
        first_name: "Scarlett",
        last_name: "Xie",
        registered_at: "2025-09-11T14:13:20.000Z",
      },
    });
  });
});

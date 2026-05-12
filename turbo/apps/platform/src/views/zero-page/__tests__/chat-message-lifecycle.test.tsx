import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { chatMessagesContract } from "@vm0/api-contracts/contracts/chat-threads";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { server } from "../../../mocks/server.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setMockFeatureSwitches } from "../../../mocks/handlers/api-feature-switches.helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { pathname } from "../../../signals/location.ts";
import {
  mockChatLifecycle,
  sendMessageInUI,
  PLACEHOLDER,
} from "./chat-test-helpers.ts";

const context = testContext();
const mockApi = createMockApi(context);

describe("chat message lifecycle", () => {
  it("should not send empty messages", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "   ");

    // Empty message is ignored — user stays on /talk/ with composer available
    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
  });

  it("sends a model-first text-only new thread without waiting for policy lookup", async () => {
    const user = userEvent.setup();
    mockChatLifecycle();
    setMockFeatureSwitches({
      [FeatureSwitchKey.ModelFirstModelProvider]: true,
    });

    const policiesDeferred = createDeferredPromise<void>(context.signal);
    let capturedModelSelection: unknown = "not-called";
    server.use(
      mockApi(zeroModelPoliciesMainContract.list, async ({ respond }) => {
        await policiesDeferred.promise;
        return respond(200, {
          policies: [],
          workspaceDefaultModel: null,
          workspaceDefaultPolicyId: null,
        });
      }),
      mockApi(chatMessagesContract.send, ({ body, respond }) => {
        capturedModelSelection = body.modelSelection;
        return respond(201, {
          runId: "run-model-first-text-only",
          threadId: body.clientThreadId ?? "fallback-thread-id",
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await sendMessageInUI(user, textarea, "Hello from model-first");

    await waitFor(() => {
      expect(capturedModelSelection).toBeNull();
      expect(pathname()).toMatch(/^\/chats\//);
    });

    policiesDeferred.resolve();
  });
});

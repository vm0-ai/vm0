import assert from "node:assert/strict";
import { test } from "node:test";

import { isPromptOrChatUrl } from "./onboarding";

test("recognizes onboarding completion destinations", () => {
  const completedPaths = [
    "/prompt",
    "/agents/agent-id/chat",
    "/chats/thread-id",
  ];

  for (const path of completedPaths) {
    assert.equal(isPromptOrChatUrl(new URL(path, "https://app.vm0.ai")), true);
  }
});

test("rejects non-completion destinations", () => {
  const incompletePaths = [
    "/onboarding/video-run",
    "/agents/agent-id/chat/extra",
    "/chats/thread-id/extra",
  ];

  for (const path of incompletePaths) {
    assert.equal(isPromptOrChatUrl(new URL(path, "https://app.vm0.ai")), false);
  }
});

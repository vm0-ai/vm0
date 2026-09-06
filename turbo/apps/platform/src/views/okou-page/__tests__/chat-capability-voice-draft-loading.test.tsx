import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import * as idb from "idb";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  context,
  findEnabledButton,
  findLink,
  installRunChat,
  NEW_CHAT_PATH,
  queryButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const flags = { [FeatureSwitchKey.VoiceInputV2]: true } as const;
const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000802";

vi.mock("idb", async () => {
  return { ...(await vi.importActual<typeof import("idb")>("idb")) };
});

function installVoiceInput(): void {
  installRunChat();
  context.mocks.browser.voiceInput({ rms: 0.12 });
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  context.mocks.http.post("*/api/voice-io/transcribe", () => {
    return HttpResponse.json({
      transcript: "voice note",
      polishedText: "Voice note.",
      language: "en-US",
    });
  });
}

test("Keep composer controls visible while checking the local voice draft", async () => {
  installVoiceInput();
  const requested = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  const openDatabase = idb.openDB;
  vi.spyOn(idb, "openDB").mockImplementation(
    async (name, version, callbacks) => {
      if (name === "okou-voice-drafts") {
        if (!requested.settled()) {
          requested.resolve();
        }
        await ready.promise;
      }
      return await openDatabase(name, version, callbacks);
    },
  );

  await setupPage({ context, path: RUN_PATH, featureSwitches: flags });
  await requested.promise;
  await fill(screen.getByRole("textbox", { name: "Message" }), "Typed notes.");
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Voice input")).toBeDisabled();
  expect(queryButton("Send")).toBeDisabled();

  ready.resolve();
  await findEnabledButton("Send");
  expect(queryButton("Voice input")).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
    "Typed notes.",
  );
});

test("Keep voice input available when switching between agent chat pages", async () => {
  installVoiceInput();
  context.mocks.data.agents([
    { agentId: AGENT_ID, displayName: "Run Agent" },
    { agentId: OTHER_AGENT_ID, displayName: "Other Agent" },
  ]);
  context.mocks.data.userPreferences({
    pinnedAgentIds: [AGENT_ID, OTHER_AGENT_ID],
  });
  context.mocks.api(agentDraftContract.get, ({ params, respond }) => {
    return respond(
      200,
      textContinuityDraft(
        params.id === AGENT_ID ? "First agent." : "Second agent.",
      ),
    );
  });

  await setupPage({ context, path: NEW_CHAT_PATH, featureSwitches: flags });
  await findEnabledButton("Voice input");
  click(await findLink("Other Agent"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Second agent.",
    );
  });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Voice note.",
    );
  });
  click(await findLink("Run Agent"));
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "First agent.",
    );
  });
  await findEnabledButton("Voice input");
  expect(queryButton("Retry")).toBeNull();
});

test("Do not show another agent's retryable recording while the current draft is pending", async () => {
  installVoiceInput();
  context.mocks.data.agents([
    { agentId: AGENT_ID, displayName: "Run Agent" },
    { agentId: OTHER_AGENT_ID, displayName: "Other Agent" },
  ]);
  context.mocks.data.userPreferences({
    pinnedAgentIds: [AGENT_ID, OTHER_AGENT_ID],
  });
  context.mocks.api(agentDraftContract.get, ({ params, respond }) => {
    return respond(
      200,
      textContinuityDraft(
        params.id === AGENT_ID ? "First agent." : "Second agent.",
      ),
    );
  });
  context.mocks.http.post("*/api/voice-io/transcribe", () => {
    return HttpResponse.json({ error: "Temporary outage" }, { status: 503 });
  });
  const errors = vi.spyOn(console, "error");
  const reportError = errors.getMockImplementation();
  if (!reportError) {
    throw new Error("Expected the unexpected-console-error guard");
  }
  errors.mockImplementation((...args: unknown[]) => {
    if (
      args[0] === "[E][Composer:VoiceDraft]" &&
      args[1] === "Voice draft transcription failed"
    ) {
      return;
    }
    reportError(...args);
  });

  await setupPage({ context, path: NEW_CHAT_PATH, featureSwitches: flags });
  click(await findEnabledButton("Voice input"));
  click(await findEnabledButton("Stop recording"));
  await findEnabledButton("Retry");
  expect(queryButton("Remove voice draft")).toBeVisible();

  const requested = context.mocks.deferred<void>();
  const ready = context.mocks.deferred<void>();
  const openDatabase = idb.openDB;
  vi.spyOn(idb, "openDB").mockImplementation(
    async (name, version, callbacks) => {
      if (name === "okou-voice-drafts") {
        if (!requested.settled()) {
          requested.resolve();
        }
        await ready.promise;
      }
      return await openDatabase(name, version, callbacks);
    },
  );

  click(await findLink("Other Agent"));
  await requested.promise;
  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Second agent.",
    );
  });
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Retry")).toBeNull();
  expect(queryButton("Remove voice draft")).toBeNull();
  expect(queryButton("Voice input")).toBeDisabled();

  ready.resolve();
  await findEnabledButton("Voice input");
  expect(queryButton("Attach")).toBeVisible();
  expect(queryButton("Retry")).toBeNull();
  expect(errors).toHaveBeenCalledWith(
    "[E][Composer:VoiceDraft]",
    "Voice draft transcription failed",
    expect.objectContaining({ status: 503 }),
  );
});

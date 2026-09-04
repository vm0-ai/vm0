import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { agentDraftContract } from "@okouai/api-contracts/contracts/agent-draft";
import {
  chatEventsContract,
  type ChatThreadDraft,
} from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListAuth,
  fastButton,
  installActiveChatBoundaries,
  installChatListAgent,
  installChatListModelPolicies,
  installChatListStream,
} from "./chat-list-test-helpers.ts";
import {
  continuityAttachment,
  continuityDraft,
  continuitySidebarLink,
  continuityThread,
  draftPlainText,
  installContinuityWorkspace,
  textContinuityDraft,
} from "./chat-continuity-test-helpers.ts";

const context = testContext();

async function messageComposer(): Promise<HTMLElement> {
  return await screen.findByRole("textbox", { name: "Message" });
}

function currentMessageComposer(): HTMLElement {
  const composer = document.querySelector<HTMLElement>(
    '[role="textbox"][aria-label="Message"]',
  );
  if (!composer) {
    throw new Error("Expected the message composer");
  }
  return composer;
}

async function openConversation(threadId: string): Promise<void> {
  await waitFor(() => {
    expect(continuitySidebarLink(threadId)).toBeVisible();
  });
  const link = continuitySidebarLink(threadId);
  click(link);
  await waitFor(() => {
    expect(continuitySidebarLink(threadId)).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      document.querySelector(`[data-chat-thread-container-id="${threadId}"]`),
    ).toBeVisible();
  });
}

function composerFileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error("Expected the composer file input");
  }
  return input;
}

test("Keep each conversation's draft separate while navigating", async () => {
  const first = continuityThread(1, 1, "First draft conversation");
  const second = continuityThread(1, 2, "Second draft conversation");
  const secondServerDraft = continuityDraft([
    {
      type: "feedback",
      quote: "Keep this quoted requirement",
      note: [{ type: "text", text: "Second conversation feedback" }],
    },
  ]);
  const workspace = await installContinuityWorkspace(context, {
    caseId: 1,
    threads: [first, second],
    drafts: new Map([[second.id, secondServerDraft]]),
  });

  await setupPage({
    context,
    path: `/chats/${first.id}`,
    auth: workspace.auth,
  });

  const firstComposer = await messageComposer();
  await userEvent.type(firstComposer, "First conversation follow-up");
  expect(firstComposer).toHaveTextContent("First conversation follow-up");

  await openConversation(second.id);
  const secondComposer = await messageComposer();
  await waitFor(() => {
    expect(secondComposer).toHaveTextContent("Second conversation feedback");
    expect(document.body).toHaveTextContent("Keep this quoted requirement");
  });
  expect(secondComposer).not.toHaveTextContent("First conversation follow-up");
  await userEvent.type(secondComposer, " and a separate note");

  await openConversation(first.id);
  await waitFor(() => {
    expect(currentMessageComposer()).toHaveTextContent(
      "First conversation follow-up",
    );
  });
  expect(currentMessageComposer()).not.toHaveTextContent("a separate note");

  await openConversation(second.id);
  await waitFor(() => {
    expect(currentMessageComposer()).toHaveTextContent("a separate note");
  });
  expect(currentMessageComposer()).not.toHaveTextContent(
    "First conversation follow-up",
  );
  expect(document.body).toHaveTextContent("Keep this quoted requirement");
});

test("Protect local edits while a saved draft is loading", async () => {
  const auth = chatListAuth(302);
  const delayedDraft = context.mocks.deferred<void>();
  const oldAttachment = continuityAttachment(2, 1, "older-notes.txt");
  let draftResponseCompleted = false;
  installChatListAgent(context);
  installChatListModelPolicies(context);
  installChatListStream(context, { caseId: 2, snapshot: [] });
  installActiveChatBoundaries(context);
  context.mocks.api(agentDraftContract.get, async ({ respond }) => {
    await delayedDraft.promise;
    draftResponseCompleted = true;
    return respond(
      200,
      textContinuityDraft("Older server draft", [oldAttachment]),
    );
  });
  context.mocks.api(agentDraftContract.patch, ({ respond }) => {
    return respond(204);
  });

  await setupPage({
    context,
    path: "/agents/c7000000-0000-4000-a000-000000000001/chat",
    auth,
  });

  const composer = await messageComposer();
  await userEvent.type(composer, "Fresh work typed locally");
  expect(composer).toHaveTextContent("Fresh work typed locally");
  delayedDraft.resolve();

  await waitFor(() => {
    expect(draftResponseCompleted).toBeTruthy();
  });
  expect(composer).toHaveTextContent("Fresh work typed locally");
  expect(composer).not.toHaveTextContent("Older server draft");
  expect(document.body).not.toHaveTextContent("older-notes.txt");
});

test("Restore a rich saved draft when a chat opens", async () => {
  const thread = continuityThread(3, 1, "Rich draft conversation");
  const referenced = continuityThread(3, 2, "Referenced launch chat");
  const attachment = continuityAttachment(3, 1, "launch-research.txt");
  const draft = continuityDraft(
    [
      { type: "text", text: "Draft opening paragraph" },
      {
        type: "chat_thread",
        threadId: referenced.id,
        titleSnapshot: referenced.title ?? "Referenced launch chat",
      },
      {
        type: "template",
        titleSnapshot: "Launch presentation",
        template: {
          type: "presentation",
          selection: { templateId: "launch-grid" },
        },
      },
      {
        type: "feedback",
        quote: "Preserve the launch date",
        note: [{ type: "text", text: "Check the final milestone" }],
      },
      {
        type: "file",
        fileId: attachment.id,
        filenameSnapshot: attachment.filename,
        contentType: attachment.contentType,
      },
    ],
    [attachment],
  );
  const workspace = await installContinuityWorkspace(context, {
    caseId: 3,
    threads: [thread, referenced],
    drafts: new Map([[thread.id, draft]]),
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
  });

  const composer = await messageComposer();
  await waitFor(() => {
    expect(composer).toHaveTextContent("Draft opening paragraph");
    expect(composer).toHaveTextContent("Referenced launch chat");
    expect(composer).toHaveTextContent("Launch presentation");
    expect(composer).toHaveTextContent("Preserve the launch date");
    expect(composer).toHaveTextContent("Check the final milestone");
    expect(document.body).toHaveTextContent("launch-research.txt");
  });
  const restoredText = composer.textContent ?? "";
  expect(restoredText.indexOf("Draft opening paragraph")).toBeLessThan(
    restoredText.indexOf("Referenced launch chat"),
  );
  expect(restoredText.indexOf("Referenced launch chat")).toBeLessThan(
    restoredText.indexOf("Launch presentation"),
  );
  expect(restoredText.indexOf("Launch presentation")).toBeLessThan(
    restoredText.indexOf("Preserve the launch date"),
  );

  await userEvent.click(fastButton("Remove launch-research.txt"));
  await waitFor(() => {
    expect(document.body).not.toHaveTextContent("launch-research.txt");
    expect(
      workspace.draftPatches.some((patch) => {
        return (
          patch.threadId === thread.id &&
          patch.draftAttachments === null &&
          draftPlainText(patch.draftUserMessage).includes(
            "Draft opening paragraph",
          )
        );
      }),
    ).toBeTruthy();
  });
  expect(composer).toHaveTextContent("Referenced launch chat");
  expect(composer).toHaveTextContent("Preserve the launch date");
});

test("Restore an unfinished voice draft when a chat opens", async () => {
  const thread = continuityThread(6, 1, "Voice draft conversation");
  const draft = {
    draftUserMessage: null,
    draftVoice: {
      version: 1,
      id: "a7000000-0000-4000-a000-000000000601",
      transcript: "Raw launch notes captured before navigation",
    },
    draftAttachments: null,
  } satisfies ChatThreadDraft;
  const workspace = await installContinuityWorkspace(context, {
    caseId: 6,
    threads: [thread],
    drafts: new Map([[thread.id, draft]]),
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
    featureSwitches: { [FeatureSwitchKey.VoiceDraft]: true },
  });

  const voiceDraft = await screen.findByLabelText("Voice draft");
  expect(voiceDraft).toBeVisible();
  expect(voiceDraft).toHaveTextContent(
    "Raw launch notes captured before navigation",
  );
  expect(fastButton("Finish", voiceDraft)).toBeEnabled();
  expect(fastButton("Remove voice draft", voiceDraft)).toBeEnabled();

  await userEvent.click(fastButton("Finish", voiceDraft));

  await waitFor(() => {
    expect(screen.queryByLabelText("Voice draft")).not.toBeInTheDocument();
    expect(currentMessageComposer()).toHaveTextContent(
      "Raw launch notes captured before navigation",
    );
  });
});

test("Save and clear typed drafts consistently", async () => {
  const target = continuityThread(4, 1, "Draft persistence target");
  const neighbor = continuityThread(4, 2, "Draft persistence neighbor");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 4,
    threads: [target, neighbor],
  });

  await setupPage({
    context,
    path: `/chats/${target.id}`,
    auth: workspace.auth,
  });

  const composer = await messageComposer();
  await userEvent.type(composer, "Unsent launch checklist");
  await waitFor(() => {
    expect(
      workspace.draftPatches.some((patch) => {
        return draftPlainText(patch.draftUserMessage).includes(
          "Unsent launch checklist",
        );
      }),
    ).toBeTruthy();
  });

  await openConversation(neighbor.id);
  await openConversation(target.id);
  await waitFor(() => {
    expect(currentMessageComposer()).toHaveTextContent(
      "Unsent launch checklist",
    );
  });

  const restoredComposer = await messageComposer();
  await userEvent.click(restoredComposer);
  await userEvent.keyboard("{Control>}a{/Control}{Backspace}");
  await waitFor(() => {
    expect(restoredComposer.textContent).toBe("");
    expect(
      workspace.draftPatches.some((patch) => {
        return (
          patch.threadId === target.id &&
          patch.draftUserMessage === null &&
          patch.draftAttachments === null
        );
      }),
    ).toBeTruthy();
  });

  await openConversation(neighbor.id);
  await openConversation(target.id);
  await waitFor(() => {
    expect(currentMessageComposer().textContent).toBe("");
  });
  expect(currentMessageComposer()).not.toHaveTextContent(
    "Unsent launch checklist",
  );
});

test("Send the current version of a restored draft and clear it", async () => {
  const thread = continuityThread(5, 1, "Draft ready to send");
  const originalAttachment = continuityAttachment(5, 1, "outdated-brief.txt");
  const workspace = await installContinuityWorkspace(context, {
    caseId: 5,
    threads: [thread],
    drafts: new Map([
      [
        thread.id,
        textContinuityDraft("Original release brief", [originalAttachment]),
      ],
    ]),
  });
  const freshFile = new File(["latest brief"], "latest-brief.txt", {
    type: "text/plain",
  });
  context.mocks.upload.success({
    id: "f7000000-0000-4000-a000-000000000501",
    filename: freshFile.name,
    contentType: freshFile.type,
    size: freshFile.size,
    url: "https://cdn.vm7.io/chat-continuity/5/latest-brief.txt",
  });
  let sentPrompt: string | undefined;
  let sentAttachmentNames: string[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (body.userMessage === undefined) {
      throw new Error("Expected a user message send");
    }
    sentPrompt = body.prompt;
    sentAttachmentNames = body.userMessage.parts.flatMap((part) => {
      return part.type === "file" ? [part.filenameSnapshot] : [];
    });
    return respond(201, {
      runId: "a7000000-0000-4000-a000-000000000005",
      threadId: body.threadId ?? thread.id,
      status: "pending",
      createdAt: "2026-08-05T04:00:00.000Z",
    });
  });

  await setupPage({
    context,
    path: `/chats/${thread.id}`,
    auth: workspace.auth,
  });

  const composer = await messageComposer();
  await waitFor(() => {
    expect(composer).toHaveTextContent("Original release brief");
    expect(document.body).toHaveTextContent("outdated-brief.txt");
  });
  await userEvent.click(fastButton("Remove outdated-brief.txt"));
  await fill(composer, "Revised release brief");
  await userEvent.upload(composerFileInput(), freshFile);
  await waitFor(() => {
    expect(fastButton("Remove latest-brief.txt")).toBeVisible();
    expect(fastButton("Send")).toBeEnabled();
  });
  await userEvent.click(fastButton("Send"));

  await waitFor(() => {
    expect(sentPrompt).toBe("Revised release brief");
    expect(sentAttachmentNames).toStrictEqual(["latest-brief.txt"]);
  });
  expect(document.body).toHaveTextContent("Revised release brief");
  expect(document.body).toHaveTextContent("latest-brief.txt");
  expect(document.body).not.toHaveTextContent("outdated-brief.txt");
  await waitFor(() => {
    expect(currentMessageComposer()).toHaveTextContent("");
    expect(
      workspace.draftPatches.some((patch) => {
        return (
          patch.threadId === thread.id &&
          patch.draftUserMessage === null &&
          patch.draftAttachments === null
        );
      }),
    ).toBeTruthy();
  });
});

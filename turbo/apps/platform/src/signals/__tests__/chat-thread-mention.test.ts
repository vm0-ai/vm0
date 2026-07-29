import { describe, expect, it } from "vitest";
import { testContext } from "./test-helpers.ts";
import {
  serializeChatThreadMention,
  splitChatThreadMentionSegments,
} from "../zero-page/chat-thread-suggestion-domain.ts";
import { createDraftSignals } from "../zero-page/chat-draft.ts";
import { createWorkflowComposerSignals } from "../zero-page/tiptap-workflow-composer.ts";

const context = testContext();

const THREAD_ID = "1fe7f3cc-40b9-49f2-8f86-5f07d8d8dfd8";

describe("serializeChatThreadMention", () => {
  it("serializes a title as a markdown link to the chat thread", () => {
    expect(serializeChatThreadMention(THREAD_ID, "Weekly sync")).toBe(
      `[Weekly sync](/chats/${THREAD_ID})`,
    );
  });

  it("backslash-escapes backslashes and square brackets in the title", () => {
    expect(serializeChatThreadMention(THREAD_ID, String.raw`a[b]c\d`)).toBe(
      String.raw`[a\[b\]c\\d](/chats/${THREAD_ID})`,
    );
  });
});

describe("splitChatThreadMentionSegments", () => {
  it("keeps plain text as a single text segment", () => {
    expect(splitChatThreadMentionSegments("hello world")).toStrictEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("splits mentions and surrounding text", () => {
    const line = `see [Weekly sync](/chats/${THREAD_ID}) for details`;
    expect(splitChatThreadMentionSegments(line)).toStrictEqual([
      { type: "text", text: "see " },
      { type: "mention", threadId: THREAD_ID, title: "Weekly sync" },
      { type: "text", text: " for details" },
    ]);
  });

  it("unescapes backslash-escaped characters in the title", () => {
    const line = serializeChatThreadMention(THREAD_ID, String.raw`a[b]c\d`);
    expect(splitChatThreadMentionSegments(line)).toStrictEqual([
      { type: "mention", threadId: THREAD_ID, title: String.raw`a[b]c\d` },
    ]);
  });

  it("ignores links that are not chat thread paths", () => {
    const line = "[docs](https://example.com) and [x](/agents/abc)";
    expect(splitChatThreadMentionSegments(line)).toStrictEqual([
      { type: "text", text: line },
    ]);
  });

  it("ignores chat links without a valid uuid", () => {
    const line = "[x](/chats/not-a-uuid)";
    expect(splitChatThreadMentionSegments(line)).toStrictEqual([
      { type: "text", text: line },
    ]);
  });

  it("ignores links with an empty title", () => {
    const line = `[](/chats/${THREAD_ID})`;
    expect(splitChatThreadMentionSegments(line)).toStrictEqual([
      { type: "text", text: line },
    ]);
  });
});

describe("chat thread mention in the workflow composer", () => {
  function mountComposer() {
    const draft = createDraftSignals();
    const composer = createWorkflowComposerSignals(draft);
    const element = document.createElement("div");
    document.body.append(element);
    const cleanup = context.store.set(composer.setContainerRef$, element);
    context.signal.addEventListener("abort", () => {
      cleanup?.();
      element.remove();
    });
    return { draft, composer };
  }

  it("restores a draft mention as an atomic chip node", () => {
    const { draft, composer } = mountComposer();
    const input = `check [Weekly sync](/chats/${THREAD_ID}) please`;
    context.store.set(draft.setInput$, input);

    const paragraph = composer.editor.state.doc.child(0);
    const mention = paragraph.child(1);
    expect(mention.type.name).toBe("chatThreadMention");
    expect(mention.attrs).toMatchObject({
      threadId: THREAD_ID,
      title: "Weekly sync",
    });
    expect(mention.isAtom).toBeTruthy();
  });

  it("round-trips the mention between the doc and the draft string", () => {
    const { draft, composer } = mountComposer();
    const input = `check [a\\[b\\]](/chats/${THREAD_ID}) please`;
    context.store.set(draft.setInput$, input);

    expect(
      composer.editor.getText({
        blockSeparator: "\n",
        textSerializers: {
          hardBreak: () => {
            return "\n";
          },
        },
      }),
    ).toBe(input);
    // A second sync with the same string must not rebuild the document.
    const doc = composer.editor.state.doc;
    context.store.set(draft.setInput$, input);
    expect(composer.editor.state.doc).toBe(doc);
  });

  it("renders the mention chip with the thread title", () => {
    const { draft, composer } = mountComposer();
    context.store.set(draft.setInput$, `[Weekly sync](/chats/${THREAD_ID})`);

    const chip = composer.editor.view.dom.querySelector(
      `span[data-chat-thread-mention="${THREAD_ID}"]`,
    );
    expect(chip?.textContent).toBe("Weekly sync");
    expect(chip).toHaveClass(
      "bg-orange-500/10",
      "text-orange-600",
      "hover:bg-orange-500/15",
    );
    expect(
      chip?.querySelector(
        'path[d="M3 20l1.3 -3.9c-2.324 -3.437 -1.426 -7.872 2.1 -10.374c3.526 -2.501 8.59 -2.296 11.845 .48c3.255 2.777 3.695 7.266 1.029 10.501c-2.666 3.235 -7.615 4.215 -11.574 2.293l-4.7 1"]',
      ),
    ).toBeInTheDocument();
  });
});

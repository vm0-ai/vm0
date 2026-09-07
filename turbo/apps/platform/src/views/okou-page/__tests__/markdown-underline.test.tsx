import { act, screen, waitFor, within } from "@testing-library/react";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  agentInstructionsContract,
  agentsByIdContract,
} from "@okouai/api-contracts/contracts/agents";
import { expect, test } from "vitest";
import { marked } from "marked";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const featureSwitches = {
  [FeatureSwitchKey.RichMarkdownUnderline]: true,
} as const;

test.each([
  { source: "++Plain underline++", text: "++Plain underline++" },
  { source: "**Prefix** ++Rich underline++", text: "++Rich underline++" },
])("Underline stays literal by default: $source", async ({ source, text }) => {
  const chat = createMarkdownChatFixture(context);
  const rows = [
    chat.outputMessage(source, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  await setupPage({ context, path: chat.path, host: "app.vm0.ai" });
  const content = await screen.findByText(text);
  expect(content).toBeVisible();
  expect(content.closest("u")).toBeNull();
});

test("A global tokenizer without a renderer cannot break chat Markdown", async () => {
  const defaults = marked.defaults;
  context.signal.addEventListener(
    "abort",
    () => {
      marked.setOptions(defaults);
    },
    { once: true },
  );
  marked.use({
    extensions: [
      {
        name: "editorOnly",
        level: "inline",
        start(source) {
          return source.indexOf("::");
        },
        tokenizer(source) {
          const match = /^::(.+?)::/u.exec(source);
          return match
            ? { type: "editorOnly", raw: match[0], text: match[1] }
            : undefined;
        },
      },
    ],
  });
  const chat = createMarkdownChatFixture(context);
  const rows = [
    chat.outputMessage("**Readable** ::extension text::", { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.vm0.ai",
    featureSwitches,
  });

  const bold = await screen.findByText("Readable");
  expect(bold.tagName).toBe("STRONG");
  expect(bold.parentElement).toHaveTextContent("Readable ::extension text::");
});

test.each(["++Underlined text++", "**Prefix** ++Underlined text++"])(
  "Underline renders without first opening an editor: %s",
  async (source) => {
    const chat = createMarkdownChatFixture(context);
    const rows = [
      chat.outputMessage(source, { seqId: 1 }),
      chat.runCompleted({ seqId: 2 }),
    ];
    chat.install({
      rows: () => {
        return rows;
      },
    });

    await setupPage({
      context,
      path: chat.path,
      host: "app.vm0.ai",
      featureSwitches,
    });

    const underline = await screen.findByText("Underlined text");
    expect(underline.tagName).toBe("U");
  },
);

test("Underline preserves nested Markdown, literal code and escaped delimiters", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = [
    "++**Nested bold** and [Nested link](https://example.com)++",
    "",
    "**++Nested underline++**",
    "",
    "++`C++` and escaped \\+\\+ markers++",
    "",
    "`++Inline literal++` and \\+\\+Escaped literal\\+\\+ and C++ / i++",
    "",
    "<code>++HTML code literal++</code>",
    "",
    "```text",
    "++Block literal++",
    "```",
    "",
    "++&lt;literal&gt; &amp; **safe**++",
  ].join("\n");
  const rows = [
    chat.outputMessage(source, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.vm0.ai",
    featureSwitches,
  });

  const bold = await screen.findByText("Nested bold");
  expect(bold.tagName).toBe("STRONG");
  expect(bold.closest("u")).not.toBeNull();
  expect(screen.getByText("Nested link").closest("u")).not.toBeNull();
  expect(screen.getByText("Nested underline").closest("strong")).not.toBeNull();
  const code = screen.getByText("C++", { selector: "code" });
  expect(code.closest("u")).toHaveTextContent("C++ and escaped ++ markers");
  expect(screen.getByText("++Inline literal++").closest("code")).not.toBeNull();
  expect(screen.getByText("++Block literal++").closest("code")).not.toBeNull();
  expect(
    screen.getByText("++HTML code literal++").closest("code"),
  ).not.toBeNull();
  expect(screen.getByText(/Escaped literal/).textContent).toContain(
    "++Escaped literal++ and C++ / i++",
  );
  expect(screen.getByText("safe").closest("u")).toHaveTextContent(
    "<literal> & safe",
  );
});

test("A streaming underline remains readable until its closing delimiter arrives", async () => {
  const chat = createMarkdownChatFixture(context);
  const rows = [
    chat.outputMessage("++Streaming text", {
      id: "streaming-underline",
      runEventId: "streaming-underline",
      seqId: 1,
    }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.vm0.ai",
    featureSwitches,
  });

  await expect(screen.findByText("++Streaming text")).resolves.toBeVisible();
  rows[0] = chat.outputMessage("++Streaming text++", {
    id: "streaming-underline",
    runEventId: "streaming-underline",
    seqId: 2,
    sequenceNumber: 1,
  });
  rows.push(chat.runCompleted({ seqId: 3, sequenceNumber: 2 }));
  context.mocks.ably.trigger(chat.realtimeTopic);

  const underline = await screen.findByText("Streaming text");
  expect(underline.tagName).toBe("U");
});

test("Changing the underline switch in Lab refreshes a previously opened chat", async () => {
  const chat = createMarkdownChatFixture(context);
  const rows = [
    chat.outputMessage("++Rollout text++", { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  let effectiveSwitches: Record<string, boolean> = {
    [FeatureSwitchKey.Lab]: true,
    [FeatureSwitchKey.RichMarkdownUnderline]: false,
  };
  await setupPage({
    context,
    path: "/_/lab",
    featureSwitches: effectiveSwitches,
  });
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches: effectiveSwitches, effectiveSwitches });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    effectiveSwitches = { ...effectiveSwitches, ...body.switches };
    return respond(200, { switches: effectiveSwitches, effectiveSwitches });
  });

  for (const enabled of [true, false]) {
    const row = (
      await screen.findByText(FeatureSwitchKey.RichMarkdownUnderline)
    ).closest("li");
    if (!row) {
      throw new Error("Expected the underline feature row");
    }
    const control = within(row).getByRole("switch");
    click(control);
    await waitFor(() => {
      expect(control).toHaveAttribute("aria-checked", String(enabled));
    });
    await act(() => {
      window.history.pushState({}, "", chat.path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    const content = await screen.findByText(
      enabled ? "Rollout text" : "++Rollout text++",
    );
    expect(content.tagName).toBe(enabled ? "U" : "P");
    await act(() => {
      window.history.back();
    });
  }
});

test("Opening and reopening an instructions editor does not change chat parsing", async () => {
  const chat = createMarkdownChatFixture(context);
  const source =
    "**Result** ++Stable underline++\n\n3. Stable list item\n4. Next item\n\n- [x] Completed task";
  const rows = [
    chat.outputMessage(source, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
  chat.install({
    rows: () => {
      return rows;
    },
  });
  context.mocks.api(agentInstructionsContract.get, ({ respond }) => {
    return respond(200, {
      filename: "AGENTS.md",
      content: "++Editor underline++\n\n1. Editor list",
    });
  });

  const agentId = "c0000000-0000-4000-a000-000000000071";
  context.mocks.api(agentsByIdContract.get, ({ respond }) => {
    return respond(200, {
      agentId,
      avatarUrl: null,
      description: "Markdown instructions",
      displayName: "Markdown Agent",
      modelProviderId: null,
      ownerId: "test-user-123",
      preferPersonalProvider: false,
      selectedModel: null,
      sound: null,
      visibility: "private",
    });
  });
  await setupPage({
    context,
    path: `/agents/${agentId}?tab=instructions`,
    host: "app.vm0.ai",
    featureSwitches,
  });

  for (let visit = 0; visit < 2; visit++) {
    const editor = await screen.findByLabelText("Instructions editor");
    expect(editor.querySelector("u")).toHaveTextContent("Editor underline");
    click(await screen.findByText("Rich content"));
    const currentPrefix = visit === 0 ? "Stable" : `Fresh ${visit - 1}`;
    expect(
      (await screen.findByText(`${currentPrefix} underline`)).tagName,
    ).toBe("U");
    expect(screen.getByText(`${currentPrefix} list item`).tagName).toBe("LI");
    // A new event forces parsing after the editor has registered its extensions.
    rows.push(
      chat.outputMessage(source.replaceAll("Stable", `Fresh ${visit}`), {
        seqId: 3 + visit,
      }),
    );
    context.mocks.ably.trigger(chat.realtimeTopic);
    expect((await screen.findByText(`Fresh ${visit} underline`)).tagName).toBe(
      "U",
    );
    expect(screen.getByText(`Fresh ${visit} list item`).tagName).toBe("LI");
    act(() => {
      window.history.back();
    });
  }
  await expect(
    screen.findByLabelText("Instructions editor"),
  ).resolves.toBeVisible();
});

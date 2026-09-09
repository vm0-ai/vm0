import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createMarkdownChatFixture,
  type MarkdownChatFixture,
} from "./markdown-page-test-helpers.ts";

const context = testContext();

function completedMessageRows(chat: MarkdownChatFixture, content: string) {
  return [
    chat.outputMessage(content, { seqId: 1 }),
    chat.runCompleted({ seqId: 2 }),
  ];
}

function escapeHtmlText(source: string): string {
  return source.replace(/[&<>]/gu, (character) => {
    switch (character) {
      case "&": {
        return "&amp;";
      }
      case "<": {
        return "&lt;";
      }
      case ">": {
        return "&gt;";
      }
      default: {
        throw new Error(`Unexpected HTML text character: ${character}`);
      }
    }
  });
}

function fakeKatexRuntime() {
  return {
    renderToString: (
      source: string,
      options: {
        readonly displayMode: boolean;
        readonly errorColor: string;
        readonly maxExpand: number;
        readonly maxSize: number;
        readonly output: string;
        readonly throwOnError: boolean;
        readonly trust: boolean;
      },
    ): string => {
      expect(options).toMatchObject({
        errorColor: "okou-katex-error",
        maxExpand: 1000,
        maxSize: 100,
        output: "mathml",
        throwOnError: false,
        trust: false,
      });
      if (source === String.raw`\notARealCommand{x}`) {
        return '<span class="katex"><math><mstyle mathcolor="okou-katex-error"><mtext>invalid</mtext></mstyle></math></span>';
      }
      if (source === String.raw`\frac{`) {
        return '<span class="katex-error" style="color:okou-katex-error">invalid</span>';
      }
      const escaped = escapeHtmlText(source);
      const display = options.displayMode ? ' display="block"' : "";
      return `<span class="katex"><math${display}><semantics><mrow><mtext>${escaped}</mtext></mrow><annotation encoding="application/x-tex">${escaped}</annotation></semantics></math></span>`;
    },
  };
}

function installKatexRuntimeIntercept(): void {
  const appendChild = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
    const isKatexScript =
      node instanceof HTMLScriptElement &&
      node.dataset.okouKatexRuntime === "0.18.7";
    if (isKatexScript) {
      vi.stubGlobal("katex", fakeKatexRuntime());
    }
    const appended = appendChild(node);
    if (isKatexScript) {
      node.dispatchEvent(new Event("load"));
    }
    return appended;
  });
}

async function expectKatexRuntimeRequest(): Promise<void> {
  const script = await waitFor(() => {
    const element = document.querySelector<HTMLScriptElement>(
      'script[data-okou-katex-runtime="0.18.7"]',
    );
    expect(element).not.toBeNull();
    return element;
  });
  if (!script) {
    throw new Error("Expected the KaTeX browser script");
  }
  expect(script.src).toMatch(/\/vendor\/katex-0\.18\.7\/katex\.min\.js$/u);
  context.signal.addEventListener("abort", () => {
    script.remove();
  });
}

test("Agent formulas render from explicit delimiters without treating currency as math", async () => {
  installKatexRuntimeIntercept();
  const chat = createMarkdownChatFixture(context);
  const source = [
    "Portfolio value is $2,499 and ticker $ABC$.",
    "",
    String.raw`Inline \(E = mc^2\).`,
    "",
    String.raw`Valid marker \(\text{okou-katex-error}\) renders.`,
    "",
    String.raw`Invalid \(\notARealCommand{x}\) stays readable.`,
    "",
    String.raw`Fatal \(\frac{\) stays readable.`,
    "",
    String.raw`\[`,
    String.raw`\begin{aligned}`,
    String.raw`x &= 1 \\`,
    "y &= 2",
    String.raw`\end{aligned}`,
    String.raw`\]`,
    "",
    String.raw`$$\int_0^1 x^2 \, dx$$`,
    "",
    "`\\(code\\)`",
    "",
    "```text",
    String.raw`\[not math\]`,
    "```",
  ].join("\n");
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    cachedFeatureSwitches: { [FeatureSwitchKey.AgentMessageMath]: false },
    featureSwitches: { [FeatureSwitchKey.AgentMessageMath]: true },
  });
  await expectKatexRuntimeRequest();

  await waitFor(() => {
    expect(
      [...document.querySelectorAll("[data-math-status]")].map((element) => {
        return (element as HTMLElement).dataset.mathStatus;
      }),
    ).toStrictEqual([
      "rendered",
      "rendered",
      "hasError",
      "hasError",
      "rendered",
      "rendered",
    ]);
    expect(document.querySelectorAll("math")).toHaveLength(4);
  });
  expect(document.querySelectorAll('math[display="block"]')).toHaveLength(2);
  const message = await screen.findByText(/Portfolio value is/);
  const frame = message.closest(".wmde-markdown");
  if (!frame) {
    throw new Error("Expected the formulas inside a Markdown frame");
  }
  expect(frame).toHaveTextContent("Portfolio value is $2,499");
  expect(frame).toHaveTextContent("ticker $ABC$");
  expect(frame).toHaveTextContent(String.raw`\text{okou-katex-error}`);
  expect(frame).toHaveTextContent(String.raw`\(\notARealCommand{x}\)`);
  expect(frame).toHaveTextContent(String.raw`\(\frac{\)`);
  expect(frame.querySelector("code")).toHaveTextContent(String.raw`\(code\)`);
  expect(frame.querySelector("pre code")).toHaveTextContent(
    String.raw`\[not math\]`,
  );
});

test("Shared Agent formulas use the fetched rollout after stale cache hydration", async () => {
  installKatexRuntimeIntercept();
  const sharedThreadId = "30000000-0000-4000-8000-000000000703";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, {
      id: sharedThreadId,
      title: "Shared formula",
      publicBrand: "okou",
      messages: [
        {
          messageIndex: 0,
          role: "assistant",
          content: String.raw`Shared \(x^2\) formula.`,
          runIndex: 0,
        },
      ],
    });
  });

  await setupPage({
    context,
    path: `/share/threads/${sharedThreadId}`,
    host: "app.okou.ai",
    cachedFeatureSwitches: { [FeatureSwitchKey.AgentMessageMath]: false },
    featureSwitches: { [FeatureSwitchKey.AgentMessageMath]: true },
  });
  await expectKatexRuntimeRequest();

  await waitFor(() => {
    expect(
      document.querySelector("[data-math-status=rendered]"),
    ).not.toBeNull();
  });
  expect(document.querySelectorAll("math")).toHaveLength(1);
});

test("The enabled rollout leaves dollar prose alone without loading KaTeX", async () => {
  const chat = createMarkdownChatFixture(context);
  const source =
    "Portfolio value is $2,499, ticker $ABC$, and inline $$not math$$.";
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.AgentMessageMath]: true },
  });

  await screen.findByText(/Portfolio value is/);
  expect(document.body).toHaveTextContent(source);
  expect(document.querySelector("math")).toBeNull();
  expect(document.querySelector("script[data-okou-katex-runtime]")).toBeNull();
});

test("The disabled rollout does not request the math runtime", async () => {
  const chat = createMarkdownChatFixture(context);
  const source = String.raw`Inline \(x^2\) and $5 remain readable.`;
  const rows = completedMessageRows(chat, source);
  chat.install({
    rows: () => {
      return rows;
    },
  });

  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.AgentMessageMath]: false },
  });

  await screen.findByText(/Inline/);
  expect(document.querySelector("math")).toBeNull();
  expect(document.querySelector("script[data-okou-katex-runtime]")).toBeNull();
});

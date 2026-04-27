import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { setMockUserPreferences } from "../../../mocks/handlers/api-user-preferences.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import { chatThreadArtifactsContract } from "@vm0/api-contracts/contracts/chat-threads";
import {
  mockChatLifecycle,
  mockSubagentThread,
  PLACEHOLDER,
  SUB_AGENT_ID,
} from "./chat-test-helpers.ts";

const context = testContext();

beforeEach(() => {
  server.use(
    http.get("https://example.com/avatar.png", () => {
      return new HttpResponse("avatar", {
        headers: { "Content-Type": "image/png" },
      });
    }),
  );
});

// CHAT-D-033: Pin pill renders conditionally in ChatThreadHeader
describe("zero chat thread page display - pin pill conditional rendering", () => {
  it("shows pin pill when agent is not pinned", async () => {
    setMockUserPreferences({ pinnedAgentIds: [] });
    mockSubagentThread("thread-header-test");

    detachedSetupPage({ context, path: "/chats/thread-header-test" });

    await waitFor(() => {
      expect(screen.getByLabelText("Pin to sidebar")).toBeInTheDocument();
    });
  });

  it("does not show pin pill when agent is already pinned", async () => {
    setMockUserPreferences({ pinnedAgentIds: [SUB_AGENT_ID] });
    mockSubagentThread("thread-header-test");

    detachedSetupPage({ context, path: "/chats/thread-header-test" });

    await waitFor(() => {
      const spans = screen.getAllByText("Assistant");
      expect(spans.length).toBeGreaterThan(0);
    });
    expect(screen.queryByLabelText("Pin to sidebar")).not.toBeInTheDocument();
  });
});

// CHAT-D-036: Attachment image previews render in ChatMessageRow
describe("zero chat thread page display - attachment image preview", () => {
  it("renders image attachment preview with the correct alt text", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content:
            "[Attached file: photo.png](https://example.com/photo.png)\nDownload with: curl https://example.com/photo.png\n",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByAltText("photo.png")).toBeInTheDocument();
    });
  });
});

// CHAT-D-037: Attachment document previews render in ChatMessageRow
describe("zero chat thread page display - attachment document preview", () => {
  it("keeps markdown attachments as chips and opens preview on click", async () => {
    const docUrl = "https://example.com/notes.md#intro";
    let requestedUrl = "";
    let requestedRange = "";
    server.use(
      http.get("https://example.com/notes.md", ({ request }) => {
        requestedUrl = request.url;
        requestedRange = request.headers.get("Range") ?? "";
        return HttpResponse.text("# PRD\n\nPreview body");
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: notes.md](${docUrl})\nDownload with: curl ${docUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open markdown preview for notes.md"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open markdown preview for notes.md"),
    );

    await waitFor(() => {
      expect(screen.getByText("PRD")).toBeInTheDocument();
      expect(screen.getByText("Preview body")).toBeInTheDocument();
    });
    expect(new URL(requestedUrl).searchParams.get("raw")).toBe("1");
    expect(requestedRange).toBe("bytes=0-65535");
  });
});

describe("zero chat thread page display - body link document preview", () => {
  it("renders markdown body links inline", async () => {
    const docUrl = "https://example.com/notes.md";
    server.use(
      http.get(docUrl, () => {
        return HttpResponse.text("# Linked PRD\n\nPreview body");
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[可爱文档](${docUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByTestId("attachment-preview-markdown"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open markdown preview for notes.md"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open markdown preview for notes.md"),
    );

    await waitFor(() => {
      expect(screen.getByText("Linked PRD")).toBeInTheDocument();
      expect(screen.getByText("Preview body")).toBeInTheDocument();
    });
  });

  it("renders html body links as preview cards", async () => {
    const htmlUrl = "https://example.com/report.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[可爱小猫页面](${htmlUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for report.html"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for report.html"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("report.html preview")).toBeInTheDocument();
    });
  });

  it("renders html body links wrapped in markdown formatting and preserves surrounding text", async () => {
    const htmlUrl = "https://example.com/cute_kitten.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>kitten preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `上传完成！点击下面的链接即可查看：\n\n**[可爱小猫页面](${htmlUrl})**\n\n页面包含居中卡片布局。`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-html")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open html preview for cute_kitten.html"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for cute_kitten.html"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("cute_kitten.html preview")).toBeInTheDocument();
    });
  });

  it("renders json body links inline and supports collapse", async () => {
    const jsonUrl = "https://example.com/data.json";
    server.use(
      http.get(jsonUrl, () => {
        return HttpResponse.text('{"status":"ok","count":2}');
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[数据](${jsonUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-json")).toBeInTheDocument();
      expect(screen.getByText(/"status": "ok"/)).toBeInTheDocument();
      expect(screen.getByText(/"count": 2/)).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Collapse json preview for data.json"),
    );

    await waitFor(() => {
      expect(screen.queryByText(/"status": "ok"/)).not.toBeInTheDocument();
    });
  });

  it("renders pdf body links as previewable document cards", async () => {
    const pdfUrl = "https://example.com/document.pdf";
    server.use(
      http.get(pdfUrl, () => {
        return new HttpResponse("%PDF-1.4", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[手册](${pdfUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-pdf")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open pdf preview for document.pdf"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open pdf preview for document.pdf"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("document.pdf preview")).toBeInTheDocument();
    });
  });

  it("renders csv body links as previewable document cards", async () => {
    const csvUrl = "https://example.com/report.csv";
    server.use(
      http.get(csvUrl, () => {
        return HttpResponse.text("name,count\nkitten,2\npuppy,3", {
          headers: { "Content-Type": "text/csv" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[报表](${csvUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-csv")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open csv preview for report.csv"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open csv preview for report.csv"),
    );

    await waitFor(() => {
      expect(screen.getByText("name")).toBeInTheDocument();
      expect(screen.getByText("count")).toBeInTheDocument();
      expect(screen.getByText("kitten")).toBeInTheDocument();
      expect(screen.getByText("2")).toBeInTheDocument();
    });
  });

  it("renders text body links inline and supports collapse", async () => {
    const txtUrl = "https://example.com/readme.txt#summary";
    let requestedUrl = "";
    let requestedRange = "";
    server.use(
      http.get("https://example.com/readme.txt", ({ request }) => {
        requestedUrl = request.url;
        requestedRange = request.headers.get("Range") ?? "";
        return HttpResponse.text("hello from text preview");
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content: `[readme](${txtUrl})`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByTestId("attachment-preview-text")).toBeInTheDocument();
      expect(screen.getByText("hello from text preview")).toBeInTheDocument();
    });
    expect(new URL(requestedUrl).searchParams.get("raw")).toBe("1");
    expect(requestedRange).toBe("bytes=0-65535");
    expect(screen.getByLabelText("Download readme.txt")).toHaveAttribute(
      "href",
      "https://example.com/readme.txt?download=1#summary",
    );

    await userEvent.click(
      screen.getByLabelText("Collapse text preview for readme.txt"),
    );

    await waitFor(() => {
      expect(
        screen.queryByText("hello from text preview"),
      ).not.toBeInTheDocument();
    });
  });

  it("preserves assistant soft line breaks without forcing hard breaks", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Here is some text that wraps\nacross multiple lines for readability.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.textContent?.replace(/\s+/g, " ")).toContain(
        "Here is some text that wraps across multiple lines for readability.",
      );
      expect(assistant?.querySelector("br")).toBeNull();
    });
  });

  it("keeps previewable markdown links inside assistant code fences as code", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "assistant",
          content:
            "Here is the syntax:\n```markdown\n[PRD](https://example.com/prd.md)\n```\nDone.",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      const assistant = document.querySelector(
        '[data-role="assistant"] .zero-chat-bubble-assistant',
      );
      expect(assistant?.textContent).toContain(
        "[PRD](https://example.com/prd.md)",
      );
    });
    expect(screen.queryByTestId("attachment-preview-markdown")).toBeNull();
    expect(
      screen.queryByLabelText("Open markdown preview for prd.md"),
    ).toBeNull();
  });
});

// CHAT-D-065: Video attachments render an inline <video controls> player.
// Covers isVideoFilename + video branch added to PagedUserMessage in #9662.
describe("zero chat thread page display - attachment video preview", () => {
  it("renders a video element with controls for mp4 attachments", async () => {
    const videoUrl = "https://example.com/clip.mp4";
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: clip.mp4](${videoUrl})\nDownload with: curl ${videoUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    const video = await waitFor(() => {
      const el = document.querySelector<HTMLVideoElement>(
        `video[src="${videoUrl}"]`,
      );
      expect(el).toBeInTheDocument();
      return el;
    });

    expect(video?.hasAttribute("controls")).toBeTruthy();
    // Must not fall through to the image or download branches.
    expect(
      document.querySelector(`img[src="${videoUrl}"]`),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('a[download="clip.mp4"]'),
    ).not.toBeInTheDocument();
  });
});

describe("zero chat thread page display - attachment html preview", () => {
  it("keeps html attachments as chips and opens preview on click", async () => {
    const htmlUrl = "https://example.com/report.html";
    server.use(
      http.get(htmlUrl, () => {
        return HttpResponse.html("<html><body>report preview</body></html>");
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: report.html](${htmlUrl})\nDownload with: curl ${htmlUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open html preview for report.html"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open html preview for report.html"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("report.html preview")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - attachment json preview", () => {
  it("keeps json attachments as chips and opens preview on click", async () => {
    const jsonUrl = "https://example.com/data.json";
    server.use(
      http.get(jsonUrl, () => {
        return HttpResponse.text('{"status":"ok","count":2}');
      }),
    );

    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: data.json](${jsonUrl})\nDownload with: curl ${jsonUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open json preview for data.json"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open json preview for data.json"),
    );

    await waitFor(() => {
      expect(screen.getByText(/"status": "ok"/)).toBeInTheDocument();
      expect(screen.getByText(/"count": 2/)).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - attachment pdf preview", () => {
  it("keeps pdf attachments as chips and opens preview on click", async () => {
    const pdfUrl = "https://example.com/document.pdf";
    server.use(
      http.get(pdfUrl, () => {
        return new HttpResponse("%PDF-1.4", {
          headers: { "Content-Type": "application/pdf" },
        });
      }),
    );
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: `[Attached file: document.pdf](${pdfUrl})\nDownload with: curl ${pdfUrl}\n`,
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Open pdf preview for document.pdf"),
      ).toBeInTheDocument();
    });

    await userEvent.click(
      screen.getByLabelText("Open pdf preview for document.pdf"),
    );

    await waitFor(() => {
      expect(screen.getByTitle("document.pdf preview")).toBeInTheDocument();
    });
  });
});

// CHAT-D-066: HeaderAgentAvatar renders null until agentId resolves — no default-avatar flicker
describe("zero chat thread page display - header agent avatar flicker fix", () => {
  it("renders the agent avatar link once agentId resolves and never renders a placeholder avatar beforehand", async () => {
    mockSubagentThread("thread-avatar-test");

    detachedSetupPage({ context, path: "/chats/thread-avatar-test" });

    // The avatar link must appear once the agent id resolves.
    await waitFor(() => {
      expect(
        document.querySelector('a[aria-label="View agent profile"]'),
      ).toBeInTheDocument();
    });

    // No blank-name placeholder SVG should have been rendered: the component
    // returns null before agentId is known, so there is never a second avatar
    // element without the accessible link wrapper.
    const avatarLinks = document.querySelectorAll(
      'a[aria-label="View agent profile"]',
    );
    expect(avatarLinks).toHaveLength(1);
  });
});

describe("zero chat thread page display - artifacts drawer", () => {
  it("opens a drawer with uploaded files grouped by run when enabled", async () => {
    const user = userEvent.setup();
    let artifactsRequests = 0;
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "See attached",
          runId: "run-artifacts-1",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });
    server.use(
      http.get("https://example.com/chart.png", () => {
        return new HttpResponse(new Blob(["img"], { type: "image/png" }), {
          headers: { "Content-Type": "image/png" },
        });
      }),
      http.get("https://example.com/data.csv", () => {
        return new HttpResponse("label,value\nalpha,1\n", {
          headers: { "Content-Type": "text/csv" },
        });
      }),
      mockApi(chatThreadArtifactsContract.list, ({ respond }) => {
        artifactsRequests += 1;
        return respond(200, {
          runs: [
            {
              runId: "run-artifacts-1",
              files: [
                {
                  id: "file-1",
                  filename: "chart.png",
                  contentType: "image/png",
                  size: 4096,
                  url: "https://example.com/chart.png",
                  createdAt: "2026-03-10T00:00:00Z",
                },
                {
                  id: "file-2",
                  filename: "data.csv",
                  contentType: "text/csv",
                  size: 2048,
                  url: "https://example.com/data.csv",
                  createdAt: "2026-03-10T00:00:00Z",
                },
              ],
            },
          ],
        });
      }),
    );
    const createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:artifact-download");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatArtifactsDrawer]: true },
    });

    const button = await waitFor(() => {
      return screen.getByLabelText("Open artifacts");
    });
    expect(artifactsRequests).toBe(0);
    click(button);

    await waitFor(() => {
      expect(screen.getByText("Artifacts")).toBeInTheDocument();
    });
    expect(artifactsRequests).toBeGreaterThan(0);
    expect(screen.getByLabelText("Preview chart.png")).toBeInTheDocument();
    const downloadButtons = screen.getAllByLabelText("Download chart.png");
    expect(downloadButtons[0]!.tagName).toBe("BUTTON");
    await user.click(downloadButtons[0]!);
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledOnce();
      expect(anchorClickSpy).toHaveBeenCalledOnce();
    });
    expect(screen.getAllByText("chart.png").length).toBeGreaterThan(0);
    expect(screen.getByText("data.csv")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Preview chart.png"));

    const lightbox = await screen.findByTestId("attachment-lightbox");
    await user.click(within(lightbox).getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("attachment-lightbox"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Artifacts")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Select data.csv"));
    expect(screen.getByTitle("Preview data.csv")).toBeInTheDocument();
  });

  it("hides the artifacts button when the feature switch is off", async () => {
    mockChatLifecycle();

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatArtifactsDrawer]: false },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Send a message to start the conversation"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Open artifacts")).not.toBeInTheDocument();
  });
});

// CHAT-D-043: Message status indicators render in ChatMessageRow
describe("zero chat thread page display - message status indicators", () => {
  it("displays a Stop button status indicator when a run is active", async () => {
    mockChatLifecycle({
      chatMessages: [
        {
          role: "user",
          content: "Hello",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-1",
          status: "running",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });
});

describe("zero chat thread page display - manual history button", () => {
  it("keeps load history hidden when the feature switch is off", async () => {
    mockChatLifecycle({
      historyMessages: [
        {
          role: "user",
          content: "Older message",
          createdAt: "2026-03-09T23:59:59Z",
        },
      ],
    });

    detachedSetupPage({ context, path: "/chats/thread-test-1" });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
    expect(screen.queryByText("Load history")).not.toBeInTheDocument();
  });

  it("shows load history when the feature switch is on and history exists", async () => {
    mockChatLifecycle({
      historyMessages: [
        {
          role: "user",
          content: "Older message",
          createdAt: "2026-03-09T23:59:59Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-test-1",
      featureSwitches: { [FeatureSwitchKey.ChatManualHistory]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Load history")).toBeInTheDocument();
    });
  });
});

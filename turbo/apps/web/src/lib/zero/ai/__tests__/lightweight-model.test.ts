import { describe, it, expect } from "vitest";
import { HttpResponse } from "msw";
import { server } from "../../../../mocks/server";
import { http } from "../../../../__tests__/msw";
import {
  generateChatTitle,
  generateRunSummary,
  generateScheduleDescription,
} from "../lightweight-model";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function openRouterResponse(content: string | null) {
  return {
    choices: [{ message: { content } }],
  };
}

describe.sequential("lightweight-model", () => {
  describe("generateChatTitle", () => {
    it("should return a title on successful response", async () => {
      const result = await generateChatTitle({
        currentUserMessage: "Help me set up my project",
      });

      expect(result).toBe("Default OpenRouter response");
    });

    it("should trim whitespace from returned content", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(openRouterResponse("  Padded Title  "));
      });
      server.use(handler.handler);

      const result = await generateChatTitle({
        currentUserMessage: "Some user message",
      });

      expect(result).toBe("Padded Title");
    });

    it("should throw when response content is empty", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(openRouterResponse(""));
      });
      server.use(handler.handler);

      await expect(
        generateChatTitle({ currentUserMessage: "Hello" }),
      ).rejects.toThrow("OpenRouter returned empty content");
      expect(handler.mocked).toHaveBeenCalledTimes(1);
    });

    it("should throw when response content is null", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json({ choices: [{ message: {} }] });
      });
      server.use(handler.handler);

      await expect(
        generateChatTitle({ currentUserMessage: "Hello" }),
      ).rejects.toThrow("OpenRouter returned empty content");
    });

    it.each([
      ["**Bold** and `code` title", "Bold and code title"],
      ["## Chat Title Here", "Chat Title Here"],
      ["*Italic* setup guide", "Italic setup guide"],
      ["__underscored__ text", "underscored text"],
      ["[Click here](https://example.com) for help", "Click here for help"],
      ["# **Bold Heading** with `code`", "Bold Heading with code"],
      ["Plain text without markdown", "Plain text without markdown"],
    ])("should strip markdown from %j → %j", async (raw, expected) => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(openRouterResponse(raw));
      });
      server.use(handler.handler);

      expect(await generateChatTitle({ currentUserMessage: "msg" })).toBe(
        expected,
      );
    });

    it("should throw on HTTP error", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.text("rate limited", { status: 429 });
      });
      server.use(handler.handler);

      await expect(
        generateChatTitle({ currentUserMessage: "Hello" }),
      ).rejects.toThrow("OpenRouter request failed: 429");
    });

    it("should label current user message, assistant reply, and prior rounds separately", async () => {
      let capturedBody: unknown;
      const handler = http.post(OPENROUTER_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(openRouterResponse("Debugging Help"));
      });
      server.use(handler.handler);

      await generateChatTitle({
        currentUserMessage: "Fix my bug",
        currentAssistantReply: "Try logging the request body first.",
        priorRounds: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi, how can I help?" },
        ],
      });

      const body = capturedBody as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages).toHaveLength(2);
      const userContent = body.messages[1]!.content;
      expect(userContent).toContain("Previous conversation");
      expect(userContent).toContain("user: Hello");
      expect(userContent).toContain("assistant: Hi, how can I help?");
      expect(userContent).toContain("Most recent user message:\nFix my bug");
      expect(userContent).toContain(
        "Most recent assistant reply:\nTry logging the request body first.",
      );
    });

    it("should cap prior rounds at the last 10 messages", async () => {
      let capturedBody: unknown;
      const handler = http.post(OPENROUTER_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(openRouterResponse("Title"));
      });
      server.use(handler.handler);

      const priorRounds = Array.from({ length: 14 }, (_, i) => {
        return {
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: `msg-${i}`,
        };
      });

      await generateChatTitle({
        currentUserMessage: "latest",
        priorRounds,
      });

      const body = capturedBody as {
        messages: Array<{ role: string; content: string }>;
      };
      const userContent = body.messages[1]!.content;
      expect(userContent).toContain("last 10 messages");
      expect(userContent).not.toContain("msg-0");
      expect(userContent).not.toContain("msg-3");
      expect(userContent).toContain("msg-4");
      expect(userContent).toContain("msg-13");
    });

    it("should omit the assistant reply section when not provided", async () => {
      let capturedBody: unknown;
      const handler = http.post(OPENROUTER_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(openRouterResponse("Title"));
      });
      server.use(handler.handler);

      await generateChatTitle({ currentUserMessage: "hello there" });

      const body = capturedBody as {
        messages: Array<{ role: string; content: string }>;
      };
      const userContent = body.messages[1]!.content;
      expect(userContent).toContain("Most recent user message:\nhello there");
      expect(userContent).not.toContain("Most recent assistant reply");
      expect(userContent).not.toContain("Previous conversation");
    });

    it("should strip surrounding quotes from title", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(openRouterResponse('"Some Quoted Title"'));
      });
      server.use(handler.handler);

      expect(await generateChatTitle({ currentUserMessage: "msg" })).toBe(
        "Some Quoted Title",
      );
    });

    it("should strip horizontal rules from title", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(openRouterResponse("---\nSome Title"));
      });
      server.use(handler.handler);

      expect(await generateChatTitle({ currentUserMessage: "msg" })).toBe(
        "Some Title",
      );
    });
  });

  describe("generateRunSummary", () => {
    it("should return a summary on successful response", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(
          openRouterResponse(
            "User asked about project setup. Agent provided step-by-step instructions.",
          ),
        );
      });
      server.use(handler.handler);

      const result = await generateRunSummary(
        "chat",
        "How do I set up this project?",
        "First install dependencies with pnpm install, then run pnpm dev.",
      );

      expect(result).toBe(
        "User asked about project setup. Agent provided step-by-step instructions.",
      );
      expect(handler.mocked).toHaveBeenCalledTimes(1);
    });

    it("should include triggerSource in the system prompt", async () => {
      let capturedBody: unknown;
      const handler = http.post(OPENROUTER_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(openRouterResponse("Summary text"));
      });
      server.use(handler.handler);

      await generateRunSummary("slack", "prompt", "result");

      const body = capturedBody as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.messages[0]!.content).toContain("slack");
    });

    it("should truncate long input to 3 lines of 80 chars each", async () => {
      let capturedBody: unknown;
      const handler = http.post(OPENROUTER_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json(openRouterResponse("Summary"));
      });
      server.use(handler.handler);

      const longLine = "x".repeat(200);
      const manyLines = Array.from({ length: 10 }, (_, i) => {
        return `Line ${i}`;
      }).join("\n");

      await generateRunSummary("chat", longLine, manyLines);

      const body = capturedBody as {
        messages: Array<{ role: string; content: string }>;
      };
      const userContent = body.messages[1]!.content;

      // Prompt should be truncated to 80 chars + ellipsis (single line)
      expect(userContent).toContain("x".repeat(80) + "…");
      expect(userContent).not.toContain("x".repeat(81));

      // Result should only have first 3 lines
      expect(userContent).toContain("Line 0");
      expect(userContent).toContain("Line 2");
      expect(userContent).not.toContain("Line 3");
    });
  });

  describe("generateScheduleDescription", () => {
    it("should return a description on successful response", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(
          openRouterResponse("Runs daily backup for production database"),
        );
      });
      server.use(handler.handler);

      const result = await generateScheduleDescription(
        "BackupBot",
        "Daily Backup",
        "Every day at 2am",
        "Back up the production database",
      );

      expect(result).toBe("Runs daily backup for production database");
      expect(handler.mocked).toHaveBeenCalledTimes(1);
    });

    it("should strip markdown from schedule descriptions", async () => {
      const handler = http.post(OPENROUTER_URL, () => {
        return HttpResponse.json(
          openRouterResponse("**Daily** `backup` for [prod](https://db.io)"),
        );
      });
      server.use(handler.handler);

      const result = await generateScheduleDescription(
        "BackupBot",
        "Daily Backup",
        "Every day at 2am",
        "Back up the production database",
      );

      expect(result).toBe("Daily backup for prod");
    });
  });
});

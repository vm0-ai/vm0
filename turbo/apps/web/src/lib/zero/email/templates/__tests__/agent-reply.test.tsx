import { describe, it, expect } from "vitest";
import { render } from "@react-email/components";
import { AgentReplyEmail } from "../agent-reply";

describe("AgentReplyEmail", () => {
  it("renders markdown output as HTML", async () => {
    const html = await render(
      AgentReplyEmail({
        agentName: "Test Agent",
        output: "## Hello\n\nThis is **bold** and `code`.",
        logsUrl: "https://example.com/logs",
      }),
    );

    expect(html).toContain("Hello");
    expect(html).toContain("bold");
    expect(html).toContain("code");
  });

  it("includes agent name in signature", async () => {
    const html = await render(
      AgentReplyEmail({
        agentName: "My Agent",
        output: "Done.",
        logsUrl: "https://example.com/logs",
      }),
    );

    expect(html).toContain("My Agent");
  });

  it("includes logs URL as audit link", async () => {
    const html = await render(
      AgentReplyEmail({
        agentName: "Test Agent",
        output: "Done.",
        logsUrl: "https://example.com/logs/run-42",
      }),
    );

    expect(html).toContain("https://example.com/logs/run-42");
  });

  it("includes unsubscribe link when provided", async () => {
    const html = await render(
      AgentReplyEmail({
        agentName: "Test Agent",
        output: "Done.",
        logsUrl: "https://example.com/logs",
        unsubscribeUrl: "https://example.com/unsubscribe",
      }),
    );

    expect(html).toContain("https://example.com/unsubscribe");
  });
});

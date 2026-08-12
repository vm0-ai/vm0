import chalk from "chalk";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroChatCommand } from "../index";

const THREAD_ID = "00000000-0000-4000-8000-000000000001";
const QUEUED_EVENT_ID = "00000000-0000-4000-8000-000000000013";
const AUTOMATION_EVENT_ID = "00000000-0000-4000-8000-000000000014";
const QUEUED_EVENTS_URL = `http://localhost:3000/api/okou/chat-threads/${THREAD_ID}/queued-events`;

describe("okou chat queued command", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-zero-token");
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
  });

  it("prints an empty authoritative queue", async () => {
    server.use(
      http.get(QUEUED_EVENTS_URL, () => {
        return HttpResponse.json({ events: [] });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "queued"]);

    expect(mockConsoleLog).toHaveBeenCalledWith("No queued chat events");
  });

  it("lists authoritative queue events and guides raw history inspection", async () => {
    server.use(
      http.get(QUEUED_EVENTS_URL, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer test-zero-token",
        );
        return HttpResponse.json({
          events: [
            { eventId: QUEUED_EVENT_ID, seqId: 344 },
            { eventId: AUTOMATION_EVENT_ID, seqId: 345 },
          ],
        });
      }),
    );

    await zeroChatCommand.parseAsync(["node", "cli", "queued"]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(QUEUED_EVENT_ID);
    expect(output).toContain(AUTOMATION_EVENT_ID);
    expect(output).toContain("344");
    expect(output).toContain("345");
    expect(output).toContain(
      `okou chat messages --thread-id ${THREAD_ID} --output-dir threads`,
    );
    expect(output).toContain(`rg -n '"seqId":344' threads/${THREAD_ID}/`);
    expect(output).toContain(`rg -n '"seqId":345' threads/${THREAD_ID}/`);
  });
});

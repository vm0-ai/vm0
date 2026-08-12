import {
  ZERO_TRANSLATION_MAX_LANGUAGE_CHARS,
  ZERO_TRANSLATION_MAX_SOURCE_TEXT_CHARS,
} from "@vm0/api-contracts/contracts/zero-translation";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { zeroTranslateCommand } from "../index";

const TRANSLATE_URL = "http://localhost:3000/api/okou/translate";

describe("okou translate command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
    return undefined as never;
  });
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("VM0_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("ZERO_TOKEN", "test-token");
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it("translates text and prints only the translation", async () => {
    let translateCalls = 0;
    server.use(
      http.post(TRANSLATE_URL, async ({ request }) => {
        translateCalls += 1;
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        await expect(request.json()).resolves.toStrictEqual({
          text: "Hello, world",
          sourceLanguage: "English",
          targetLanguage: "Simplified Chinese",
        });
        return HttpResponse.json({
          text: "你好，世界",
          metadata: { creditsCharged: 2 },
        });
      }),
    );

    await zeroTranslateCommand.parseAsync([
      "node",
      "okou",
      "  Hello, world  ",
      "--from",
      "  English  ",
      "--to",
      "  Simplified Chinese  ",
    ]);

    expect(translateCalls).toBe(1);
    expect(mockConsoleLog.mock.calls).toStrictEqual([["你好，世界"]]);
    expect(mockConsoleError).not.toHaveBeenCalled();
    expect(mockExit).not.toHaveBeenCalled();
  });

  it("omits the source language for auto-detection", async () => {
    server.use(
      http.post(TRANSLATE_URL, async ({ request }) => {
        await expect(request.json()).resolves.toStrictEqual({
          text: "Bonjour",
          targetLanguage: "English",
        });
        return HttpResponse.json({
          text: "Hello",
          metadata: { creditsCharged: 2 },
        });
      }),
    );

    await zeroTranslateCommand.parseAsync([
      "node",
      "okou",
      "Bonjour",
      "--to",
      "English",
    ]);

    expect(mockConsoleLog).toHaveBeenCalledWith("Hello");
  });

  it("rejects invalid inputs before calling the API", async () => {
    let networkCalled = false;
    server.use(
      http.post(TRANSLATE_URL, () => {
        networkCalled = true;
        return HttpResponse.json({});
      }),
    );
    const invalidInputs = [
      { text: "   ", to: "English" },
      {
        text: "x".repeat(ZERO_TRANSLATION_MAX_SOURCE_TEXT_CHARS + 1),
        to: "English",
      },
      { text: "hello", to: "   " },
      {
        text: "hello",
        to: "x".repeat(ZERO_TRANSLATION_MAX_LANGUAGE_CHARS + 1),
      },
    ];

    for (const input of invalidInputs) {
      mockConsoleError.mockClear();
      await zeroTranslateCommand.parseAsync([
        "node",
        "okou",
        input.text,
        "--to",
        input.to,
      ]);
      expect(mockConsoleError).toHaveBeenCalled();
    }
    expect(networkCalled).toBe(false);
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("prints API failures to stderr without billing metadata", async () => {
    server.use(
      http.post(TRANSLATE_URL, () => {
        return HttpResponse.json(
          {
            error: {
              message: "Translation is temporarily unavailable",
              code: "PROVIDER_UNAVAILABLE",
            },
          },
          { status: 503 },
        );
      }),
    );

    await zeroTranslateCommand.parseAsync([
      "node",
      "okou",
      "Hello",
      "--to",
      "Chinese",
    ]);

    expect(mockConsoleLog).not.toHaveBeenCalled();
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "temporarily unavailable",
    );
    expect(mockConsoleError.mock.calls.flat().join("\n")).not.toContain(
      "creditsCharged",
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("exposes no model, retry, JSON, or billing options", () => {
    const optionNames = zeroTranslateCommand.options.map((option) => {
      return option.attributeName();
    });
    expect(optionNames).toStrictEqual(["to", "from"]);
  });
});

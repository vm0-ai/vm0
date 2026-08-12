import { describe, it, expect, vi, afterEach } from "vitest";
import { Command, Help } from "commander";
import { buildZeroHelpText, registerZeroCommands } from "../okou";
import { decodeZeroTokenPayload } from "../lib/api/zero-token";

function buildZeroToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `vm0_sandbox_${header}.${body}.test-signature`;
}

function buildCommands(): Command[] {
  return [
    new Command("org"),
    new Command("model"),
    new Command("model-provider"),
    new Command("agent"),
    new Command("connector"),
    new Command("mcp"),
    new Command("presentation-template"),
    new Command("credit"),
    new Command("upgrade"),
    new Command("logs"),
    new Command("chat"),
    new Command("resource"),
    new Command("schedule"),
    new Command("github"),
    new Command("slack"),
    new Command("feishu"),
    new Command("teams"),
    new Command("telegram"),
    new Command("phone"),
    new Command("whoami"),
    new Command("browser"),
    new Command("generate"),
    new Command("web"),
    new Command("host"),
    new Command("maps"),
    new Command("weather"),
    new Command("scrape"),
    new Command("people-search"),
    new Command("web-search"),
    new Command("recognize"),
    new Command("translate"),
    new Command("finance"),
    new Command("seo"),
    new Command("banking"),
    new Command("goal"),
  ];
}

function buildProgram(): Command {
  const prog = new Command();
  registerZeroCommands(prog, buildCommands());
  return prog;
}

function visibleCommandNames(prog: Command): string[] {
  return new Help()
    .visibleCommands(prog)
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return name !== "help";
    });
}

function hiddenCommandNames(prog: Command): string[] {
  const visible = new Set(visibleCommandNames(prog));
  return prog.commands
    .map((cmd) => {
      return cmd.name();
    })
    .filter((name) => {
      return !visible.has(name);
    });
}

function registeredCommandNames(prog: Command): string[] {
  return prog.commands.map((command) => {
    return command.name();
  });
}

describe("decodeZeroTokenPayload", () => {
  it("should decode payload from a valid zero-scoped token", () => {
    const token = buildZeroToken({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "okou",
      capabilities: ["agent:read", "connector:read"],
      iat: 1000,
      exp: 2000,
    });
    const payload = decodeZeroTokenPayload(token);
    expect(payload).toEqual({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "okou",
      capabilities: ["agent:read", "connector:read"],
      iat: 1000,
      exp: 2000,
    });
  });

  it("should decode payload from a valid okou-scoped token", () => {
    const token = buildZeroToken({
      userId: "user-okou",
      runId: "run-okou",
      orgId: "org-okou",
      scope: "okou",
      capabilities: ["agent:read"],
      iat: 1000,
      exp: 2000,
    });

    expect(decodeZeroTokenPayload(token)).toMatchObject({
      userId: "user-okou",
      scope: "okou",
      capabilities: ["agent:read"],
    });
  });

  it("should return undefined for token without vm0_sandbox_ prefix", () => {
    expect(decodeZeroTokenPayload("some-other-token")).toBeUndefined();
  });

  it("should return undefined for malformed JWT (not 3 parts)", () => {
    expect(decodeZeroTokenPayload("vm0_sandbox_only-one-part")).toBeUndefined();
  });

  it("should return undefined for non-zero scope", () => {
    const token = buildZeroToken({
      scope: "sandbox",
      capabilities: ["agent:read"],
    });
    expect(decodeZeroTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined when capabilities is not an array", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: "not-an-array",
    });
    expect(decodeZeroTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined for invalid base64 payload", () => {
    expect(
      decodeZeroTokenPayload("vm0_sandbox_a.!!!invalid.c"),
    ).toBeUndefined();
  });
});

describe("registerZeroCommands", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should register globally enabled commands when OKOU_TOKEN is absent", () => {
    vi.stubEnv("OKOU_TOKEN", undefined);

    const prog = buildProgram();
    expect(hiddenCommandNames(prog)).toEqual([
      "mcp",
      "presentation-template",
      "recognize",
      "translate",
    ]);
    expect(registeredCommandNames(prog)).toContain("upgrade");
    expect(visibleCommandNames(prog)).toContain("browser");
  });

  it("should hide unmapped commands and show capable ones with valid token", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual([
      "model",
      "model-provider",
      "agent",
      "presentation-template",
      "upgrade",
      "resource",
      "whoami",
      "generate",
      "web",
    ]);
    expect(hiddenCommandNames(prog)).toEqual([
      "org",
      "connector",
      "mcp",
      "credit",
      "logs",
      "chat",
      "schedule",
      "github",
      "slack",
      "feishu",
      "teams",
      "telegram",
      "phone",
      "browser",
      "host",
      "maps",
      "weather",
      "scrape",
      "people-search",
      "web-search",
      "recognize",
      "translate",
      "finance",
      "seo",
      "banking",
      "goal",
    ]);
  });

  it("prefers OKOU_TOKEN when both token names are present", () => {
    vi.stubEnv(
      "OKOU_TOKEN",
      buildZeroToken({ scope: "okou", capabilities: ["agent:read"] }),
    );
    vi.stubEnv(
      "ZERO_TOKEN",
      buildZeroToken({ scope: "okou", capabilities: ["connector:read"] }),
    );

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("agent");
    expect(visibleCommandNames(prog)).not.toContain("connector");
  });

  it("should hide run-only commands and keep global commands visible with malformed token", () => {
    vi.stubEnv("OKOU_TOKEN", "not-a-valid-token");

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toEqual([
      "mcp",
      "presentation-template",
      "recognize",
      "translate",
    ]);
    expect(registeredCommandNames(prog)).toContain("upgrade");
    expect(visibleCommandNames(prog)).toContain("browser");
  });

  it("should hide run-only commands and keep global commands visible outside zero scope", () => {
    const token = buildZeroToken({
      scope: "sandbox",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toEqual([
      "mcp",
      "presentation-template",
      "recognize",
      "translate",
    ]);
    expect(registeredCommandNames(prog)).toContain("upgrade");
    expect(visibleCommandNames(prog)).toContain("browser");
  });

  it("should show globally enabled commands when capabilities array is empty", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual([
      "model",
      "model-provider",
      "presentation-template",
      "upgrade",
      "resource",
      "whoami",
      "generate",
      "web",
    ]);
  });

  it("should show scrape when scrape:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["scrape:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("scrape");
  });

  it("should show web-search when web-search:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["web-search:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("web-search");
  });

  it("should show finance when finance:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["finance:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("finance");
  });

  it("should show seo when seo:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["seo:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("seo");
  });

  it("should show people-search only with people-search:read capability", () => {
    const hiddenToken = buildZeroToken({
      scope: "okou",
      capabilities: ["web-search:read"],
    });
    vi.stubEnv("OKOU_TOKEN", hiddenToken);
    expect(hiddenCommandNames(buildProgram())).toContain("people-search");

    const visibleToken = buildZeroToken({
      scope: "okou",
      capabilities: ["people-search:read"],
    });
    vi.stubEnv("OKOU_TOKEN", visibleToken);
    expect(visibleCommandNames(buildProgram())).toContain("people-search");
  });

  it("should show credit with either billing read or billing write capability", () => {
    for (const capability of ["billing:read", "billing:write"]) {
      const token = buildZeroToken({
        scope: "okou",
        capabilities: [capability],
      });
      vi.stubEnv("OKOU_TOKEN", token);

      const prog = buildProgram();

      expect(visibleCommandNames(prog)).toContain("credit");
    }
  });

  it("should show model commands even without model-provider capabilities", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("model");
    expect(visibleCommandNames(prog)).toContain("model-provider");
  });

  it("should show slack when slack:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["slack:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("slack");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show feishu when feishu:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["feishu:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();
    expect(visibleCommandNames(prog)).toContain("feishu");
    expect(hiddenCommandNames(prog)).not.toContain("feishu");
  });

  it("should show github when github:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["github:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("github");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show github when github:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["github:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("github");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show chat when chat-thread:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["chat-thread:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("chat");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show chat when chat-thread:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["chat-thread:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("chat");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show chat when chat-event:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["chat-event:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("chat");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show chat when chat-event:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["chat-event:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("chat");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show telegram when telegram:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["telegram:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("telegram");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show telegram when telegram:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["telegram:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("telegram");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show phone when phone:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["phone:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("phone");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show phone when phone:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["phone:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("phone");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide telegram when only file:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should hide telegram when only file:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should show generate when file:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("generate");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show host when host:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["host:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("host");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show host when host:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["host:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("host");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show generate when file capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("generate");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show maps when maps:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["maps:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("maps");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide maps when maps:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("maps");
  });

  it("should show weather when weather:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["weather:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("weather");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide weather when weather:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("weather");
  });

  it("should show banking when banking:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["banking:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("banking");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide banking when banking:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("banking");
  });

  it("should show goal when goal capabilities are present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: [
        "goal:read",
        "goal:agent-result:write",
        "goal:user-control:write",
      ],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("goal");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide goal when goal capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("goal");
  });

  it("should show credit when billing:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["billing:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("credit");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide credit but keep globally enabled upgrade guidance when billing capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("credit");
    expect(registeredCommandNames(prog)).toContain("upgrade");
  });

  it("should show upgrade guidance", () => {
    vi.stubEnv("OKOU_TOKEN", undefined);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("upgrade");
    expect(buildZeroHelpText()).toContain("Upgrade plan?");
  });

  it("should expose browser when its capability is enabled", () => {
    const enabledToken = buildZeroToken({
      scope: "okou",
      userId: "user-1",
      orgId: "org-1",
      capabilities: ["browser:read"],
    });
    vi.stubEnv("OKOU_TOKEN", enabledToken);

    expect(visibleCommandNames(buildProgram())).toContain("browser");
  });

  it("should expose recognition only to eligible Zero runs", () => {
    vi.stubEnv("OKOU_TOKEN", undefined);
    const noTokenProgram = buildProgram();
    expect(registeredCommandNames(noTokenProgram)).toContain("recognize");
    expect(hiddenCommandNames(noTokenProgram)).toContain("recognize");

    const missingCapabilityToken = buildZeroToken({
      scope: "okou",
      userId: "user-1",
      orgId: "org-1",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", missingCapabilityToken);
    expect(hiddenCommandNames(buildProgram())).toContain("recognize");

    const eligibleToken = buildZeroToken({
      scope: "okou",
      userId: "user-1",
      orgId: "org-1",
      capabilities: ["image-recognition:write"],
    });
    vi.stubEnv("OKOU_TOKEN", eligibleToken);
    expect(visibleCommandNames(buildProgram())).toContain("recognize");
    expect(buildZeroHelpText(decodeZeroTokenPayload(eligibleToken))).toContain(
      "Recognize an image?",
    );
  });

  it("should expose translation only to capable Zero runs", () => {
    vi.stubEnv("OKOU_TOKEN", undefined);
    const noTokenProgram = buildProgram();
    expect(registeredCommandNames(noTokenProgram)).toContain("translate");
    expect(hiddenCommandNames(noTokenProgram)).toContain("translate");

    const missingCapabilityToken = buildZeroToken({
      scope: "okou",
      userId: "user-1",
      orgId: "org-1",
      capabilities: [],
    });
    vi.stubEnv("OKOU_TOKEN", missingCapabilityToken);
    expect(hiddenCommandNames(buildProgram())).toContain("translate");

    const capableToken = buildZeroToken({
      scope: "okou",
      userId: "user-1",
      orgId: "org-1",
      capabilities: ["translation:write"],
    });
    vi.stubEnv("OKOU_TOKEN", capableToken);
    expect(visibleCommandNames(buildProgram())).toContain("translate");
    expect(buildZeroHelpText(decodeZeroTokenPayload(capableToken))).toContain(
      "Translate text?",
    );
  });

  it("should show billing help examples only for billing capabilities", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["billing:read", "billing:write"],
    });
    const help = buildZeroHelpText(decodeZeroTokenPayload(token));

    expect(help).toContain("Check credits?");
    expect(help).toContain("Buy credits?");
  });

  it("should show only credit status help for billing read capability", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["billing:read"],
    });
    const help = buildZeroHelpText(decodeZeroTokenPayload(token));

    expect(help).toContain("Check credits?");
    expect(help).toContain("okou credit");
    expect(help).not.toContain("Buy credits?");
    expect(help).toContain("Upgrade plan?");
  });

  it("should show only credit purchase help for billing write capability", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["billing:write"],
    });
    const help = buildZeroHelpText(decodeZeroTokenPayload(token));

    expect(help).not.toContain("Check credits?");
    expect(help).toContain("Buy credits?");
  });

  it("should hide billing help examples when billing capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    const help = buildZeroHelpText(decodeZeroTokenPayload(token));

    expect(help).not.toContain("Check credits?");
    expect(help).not.toContain("Buy credits?");
  });

  it("should show the maps help example when maps:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["maps:read"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Get directions?",
    );
  });

  it("should hide the maps help example when maps:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Get directions?",
    );
  });

  it("should show the weather help example when weather:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["weather:read"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Check weather?",
    );
  });

  it("should hide the weather help example when weather:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Check weather?",
    );
  });

  it("should show the scrape help example when scrape:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["scrape:read"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Scrape a web page?",
    );
  });

  it("should hide the scrape help example when scrape:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Scrape a web page?",
    );
  });

  it("should show the finance help example when finance:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["finance:read"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Get a market quote?",
    );
  });

  it("should hide the finance help example when finance:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Get a market quote?",
    );
  });

  it("should gate the SEO help example on seo:read", () => {
    const visibleToken = buildZeroToken({
      scope: "okou",
      capabilities: ["seo:read"],
    });
    const hiddenToken = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(visibleToken))).toContain(
      "Research SEO data?",
    );
    expect(
      buildZeroHelpText(decodeZeroTokenPayload(hiddenToken)),
    ).not.toContain("Research SEO data?");
  });

  it("should show the people-search help example when people-search:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["people-search:read"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Find a professional?",
    );
  });

  it("should hide the people-search help example when people-search:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Find a professional?",
    );
  });

  it("should show the banking help example when banking:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["banking:read"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Read bank data?",
    );
  });

  it("should hide the banking help example when banking:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Read bank data?",
    );
  });

  it("should show the host help example when host:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["host:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Host a static site?",
    );
  });

  it("should show the hosted site clone help example when host:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["host:read"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Clone hosted site?",
    );
    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Host a static site?",
    );
  });

  it("should show the website help example", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: [],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Generate website?",
    );
  });

  it("should hide host when host:write capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("host");
  });

  it("should hide the host help example when host:write capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["file:write"],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Host a static site?",
    );
    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).not.toContain(
      "Clone hosted site?",
    );
  });

  it("should show the model help example in sandbox help", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: [],
    });

    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "List models?",
    );
    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Model routing?",
    );
  });

  it("should hide telegram when file read and telegram write capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("telegram");
    expect(hiddenCommandNames(prog)).toContain("teams");
    expect(hiddenCommandNames(prog)).toContain("phone");
  });

  it("should show teams when teams:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["teams:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("teams");
    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Send Teams?",
    );
    expect(buildZeroHelpText(decodeZeroTokenPayload(token))).toContain(
      "Download Teams?",
    );
  });

  it("should show logs when agent-run:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["agent-run:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("logs");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should hide logs when agent-run:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("logs");
  });

  it("should hide agent when agent:read capability is missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["connector:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toEqual([
      "model",
      "model-provider",
      "connector",
      "mcp",
      "presentation-template",
      "upgrade",
      "resource",
      "whoami",
      "generate",
      "web",
    ]);
    expect(hiddenCommandNames(prog)).toContain("agent");
  });

  it("should show connector when connector:read capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["connector:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(visibleCommandNames(prog)).toContain("connector");
    expect(visibleCommandNames(prog)).toContain("whoami");
  });

  it("should show run-only mcp only with connector:read capability", () => {
    const readToken = buildZeroToken({
      scope: "okou",
      capabilities: ["connector:read"],
    });
    vi.stubEnv("OKOU_TOKEN", readToken);
    expect(visibleCommandNames(buildProgram())).toContain("mcp");

    const writeToken = buildZeroToken({
      scope: "okou",
      capabilities: ["connector:write"],
    });
    vi.stubEnv("OKOU_TOKEN", writeToken);
    expect(hiddenCommandNames(buildProgram())).toContain("mcp");

    vi.stubEnv("OKOU_TOKEN", undefined);
    expect(hiddenCommandNames(buildProgram())).toContain("mcp");
  });

  it("should show connector when connector:write capability is present", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["connector:write"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    expect(visibleCommandNames(buildProgram())).toContain("connector");
  });

  it("should hide connector when connector capabilities are missing", () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: ["agent:read"],
    });
    vi.stubEnv("OKOU_TOKEN", token);

    const prog = buildProgram();

    expect(hiddenCommandNames(prog)).toContain("connector");
  });
});

describe("okou generate command visibility", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function importGenerateCommand(token: string) {
    vi.resetModules();
    vi.stubEnv("OKOU_TOKEN", token);
    const { generateCommand } = await import("../commands/zero/generate");
    return generateCommand as Command;
  }

  it("should show website generation", async () => {
    const token = buildZeroToken({
      scope: "okou",
      capabilities: [],
    });

    const generateCommand = await importGenerateCommand(token);

    expect(visibleCommandNames(generateCommand)).toContain("website");
  });

  it("should show source-backed artifact generation", async () => {
    const token = buildZeroToken({
      userId: "user-non-staff",
      orgId: "org-non-staff",
      scope: "okou",
      capabilities: ["host:write"],
    });

    const generateCommand = await importGenerateCommand(token);

    expect(visibleCommandNames(generateCommand)).toEqual(
      expect.arrayContaining([
        "report",
        "docs-design",
        "poster",
        "dashboard-design",
        "mobile-app-design",
      ]),
    );
  });
});

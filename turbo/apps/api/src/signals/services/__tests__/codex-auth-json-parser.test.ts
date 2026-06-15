import { describe, expect, it } from "vitest";

import {
  isCodexAuthJsonFreePlanError,
  isCodexAuthJsonShapeError,
  parseCodexAuthJson,
} from "../codex-auth-json-parser";
import { now } from "../../../lib/time";

function expectShapeError(fn: () => unknown): void {
  expect(fn).toThrow(/auth\.json/);
}

function expectFreePlanError(fn: () => unknown): void {
  expect(fn).toThrow(/ChatGPT free plan is not supported/);
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

interface IdTokenOpts {
  accountId?: string | null;
  planType?: string | null;
  workspaceName?: string;
  workspaceClaim?:
    | "organization.title"
    | "workspace.name"
    | "chatgpt_workspace_name";
  exp?: number;
  omitAuth?: boolean;
}

function makeIdToken(opts: IdTokenOpts = {}): string {
  if (opts.omitAuth) {
    return makeJwt({ exp: opts.exp ?? Math.floor(now() / 1000) + 3600 });
  }
  const auth: Record<string, unknown> = {};
  if (opts.accountId !== null && opts.accountId !== undefined) {
    auth.chatgpt_account_id = opts.accountId;
  }
  if (opts.planType !== null && opts.planType !== undefined) {
    auth.chatgpt_plan_type = opts.planType;
  }
  if (opts.workspaceName !== undefined) {
    if (opts.workspaceClaim === "organization.title") {
      auth.organization = { title: opts.workspaceName };
    } else if (opts.workspaceClaim === "workspace.name") {
      auth.workspace = { name: opts.workspaceName };
    } else {
      auth.chatgpt_workspace_name = opts.workspaceName;
    }
  }
  return makeJwt({
    "https://api.openai.com/auth": auth,
    exp: opts.exp ?? Math.floor(now() / 1000) + 3600,
  });
}

interface AuthJsonOpts {
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  idToken?: string;
  withApiKey?: boolean;
}

function makeAuthJson(opts: AuthJsonOpts = {}): string {
  const accessTokenExp = Math.floor(now() / 1000) + 3600;
  return JSON.stringify({
    OPENAI_API_KEY: opts.withApiKey ? "sk-test" : null,
    tokens: {
      access_token:
        opts.accessToken ?? makeJwt({ exp: accessTokenExp, sub: "user" }),
      refresh_token: opts.refreshToken ?? "rt_synthetic_high_entropy_value",
      account_id: opts.accountId ?? "ws_acct_synthetic",
      id_token:
        opts.idToken ??
        makeIdToken({
          accountId: "ws_acct_from_id_token",
          planType: "plus",
          workspaceName: "Acme",
          workspaceClaim: "organization.title",
        }),
    },
    last_refresh: "2026-05-06T08:30:00Z",
  });
}

function namedError(name: string): Error {
  const error = new Error("test");
  error.name = name;
  return error;
}

describe("parseCodexAuthJson", () => {
  describe("happy path", () => {
    it("parses a valid auth.json and returns ParsedCodexAuth", () => {
      const accessExp = Math.floor(now() / 1000) + 7200;
      const accessToken = makeJwt({ exp: accessExp, sub: "user_abc" });
      const idToken = makeIdToken({
        accountId: "ws_acct_from_id_token",
        planType: "plus",
        workspaceName: "Acme",
        workspaceClaim: "organization.title",
      });
      const result = parseCodexAuthJson(
        makeAuthJson({ accessToken, idToken, accountId: "ws_acct_plain" }),
      );

      expect(result.accessToken).toBe(accessToken);
      expect(result.idToken).toBe(idToken);
      expect(result.refreshToken).toMatch(/^rt_/);
      expect(result.accountId).toBe("ws_acct_from_id_token");
      expect(result.accountId).not.toBe("ws_acct_plain");
      expect(result.planType).toBe("plus");
      expect(result.workspaceName).toBe("Acme");
      expect(result.tokenExpiresAt.getTime()).toBe(accessExp * 1000);
    });

    it("ignores OPENAI_API_KEY field in outer object", () => {
      expect(() => {
        parseCodexAuthJson(makeAuthJson({ withApiKey: true }));
      }).not.toThrow();
    });

    it.each(["plus", "pro", "business", "edu", "enterprise"])(
      "accepts plan_type %s",
      (planType) => {
        const idToken = makeIdToken({
          accountId: "ws_acct",
          planType,
          workspaceName: "W",
        });
        const result = parseCodexAuthJson(makeAuthJson({ idToken }));
        expect(result.planType).toBe(planType);
      },
    );
  });

  describe("tokenExpiresAt derivation", () => {
    it("derives tokenExpiresAt from access_token.exp", () => {
      const accessExp = 2_000_000_000;
      const idExp = 1_999_000_000;
      const accessToken = makeJwt({ exp: accessExp });
      const idToken = makeIdToken({
        accountId: "ws_acct",
        planType: "plus",
        exp: idExp,
      });
      const result = parseCodexAuthJson(makeAuthJson({ accessToken, idToken }));
      expect(result.tokenExpiresAt.getTime()).toBe(accessExp * 1000);
    });

    it("falls back to id_token.exp when access_token is opaque", () => {
      const idExp = 2_000_000_000;
      const idToken = makeIdToken({
        accountId: "ws_acct",
        planType: "plus",
        exp: idExp,
      });
      const result = parseCodexAuthJson(
        makeAuthJson({
          accessToken: "opaque-not-a-jwt-token",
          idToken,
        }),
      );
      expect(result.tokenExpiresAt.getTime()).toBe(idExp * 1000);
    });

    it("throws when both access_token and id_token lack exp", () => {
      const accessTokenNoExp = makeJwt({ sub: "user" });
      const idTokenNoExp = makeJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "ws_acct",
          chatgpt_plan_type: "plus",
        },
      });
      expectShapeError(() => {
        return parseCodexAuthJson(
          makeAuthJson({
            accessToken: accessTokenNoExp,
            idToken: idTokenNoExp,
          }),
        );
      });
    });
  });

  describe("workspace name extraction", () => {
    it.each(["organization.title", "workspace.name", "chatgpt_workspace_name"])(
      "extracts workspaceName from %s claim shape",
      (claimShape) => {
        const idToken = makeIdToken({
          accountId: "ws_acct",
          planType: "plus",
          workspaceName: "Acme",
          workspaceClaim: claimShape as
            | "organization.title"
            | "workspace.name"
            | "chatgpt_workspace_name",
        });
        const result = parseCodexAuthJson(makeAuthJson({ idToken }));
        expect(result.workspaceName).toBe("Acme");
      },
    );

    it("returns null workspaceName when no workspace claim is present", () => {
      const idToken = makeIdToken({ accountId: "ws_acct", planType: "plus" });
      const result = parseCodexAuthJson(makeAuthJson({ idToken }));
      expect(result.workspaceName).toBeNull();
    });
  });

  describe("shape errors", () => {
    it("throws on malformed JSON", () => {
      expectShapeError(() => {
        return parseCodexAuthJson("{ not valid json");
      });
    });

    it("throws on missing tokens key", () => {
      const raw = JSON.stringify({ OPENAI_API_KEY: "sk-test" });
      expectShapeError(() => {
        return parseCodexAuthJson(raw);
      });
    });

    it("throws on missing tokens.refresh_token", () => {
      const raw = JSON.stringify({
        tokens: {
          access_token: makeJwt({ exp: now() }),
          account_id: "ws_acct",
          id_token: makeIdToken({
            accountId: "ws_acct",
            planType: "plus",
          }),
        },
      });
      expectShapeError(() => {
        return parseCodexAuthJson(raw);
      });
    });

    it("throws on empty tokens.access_token", () => {
      const raw = JSON.stringify({
        tokens: {
          access_token: "",
          refresh_token: "rt",
          account_id: "ws",
          id_token: makeIdToken({ accountId: "ws", planType: "plus" }),
        },
      });
      expectShapeError(() => {
        return parseCodexAuthJson(raw);
      });
    });

    it("throws when id_token has no required claims", () => {
      const idToken = makeIdToken({ omitAuth: true });
      expectShapeError(() => {
        return parseCodexAuthJson(makeAuthJson({ idToken }));
      });
    });

    it("throws when id_token is missing chatgpt_account_id", () => {
      const idToken = makeIdToken({ accountId: null, planType: "plus" });
      expectShapeError(() => {
        return parseCodexAuthJson(makeAuthJson({ idToken }));
      });
    });

    it("throws when id_token is missing chatgpt_plan_type", () => {
      const idToken = makeIdToken({ accountId: "ws", planType: null });
      expectShapeError(() => {
        return parseCodexAuthJson(makeAuthJson({ idToken }));
      });
    });

    it("throws when id_token is not a parsable JWT", () => {
      expectShapeError(() => {
        return parseCodexAuthJson(
          makeAuthJson({ idToken: "not-a-jwt-at-all" }),
        );
      });
    });

    it("throws when raw blob exceeds 16 KiB", () => {
      const oversized = " ".repeat(17 * 1024) + makeAuthJson();
      expectShapeError(() => {
        return parseCodexAuthJson(oversized);
      });
    });
  });

  describe("free-plan rejection", () => {
    it("throws when plan_type is 'free'", () => {
      const idToken = makeIdToken({ accountId: "ws", planType: "free" });
      expectFreePlanError(() => {
        return parseCodexAuthJson(makeAuthJson({ idToken }));
      });
    });

    it("free-plan and shape error guards are distinct", () => {
      const freePlanError = namedError("CodexAuthJsonFreePlanError");
      const shapeError = namedError("CodexAuthJsonShapeError");

      expect(isCodexAuthJsonFreePlanError(freePlanError)).toBeTruthy();
      expect(isCodexAuthJsonShapeError(freePlanError)).toBeFalsy();
      expect(isCodexAuthJsonShapeError(shapeError)).toBeTruthy();
      expect(isCodexAuthJsonFreePlanError(shapeError)).toBeFalsy();
    });
  });
});

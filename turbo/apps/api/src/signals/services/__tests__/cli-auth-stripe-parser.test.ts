import { describe, expect, it } from "vitest";

import {
  parseStripeCliAuthConfig,
  parseStripeCliAuthStartOutput,
  redactStripeCliAuthText,
} from "../cli-auth-stripe-parser";

function startOutput(
  args: {
    readonly browserUrl?: string;
    readonly nextStep?: string;
    readonly verificationCode?: string;
  } = {},
) {
  return JSON.stringify({
    browser_url:
      args.browserUrl ??
      "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
    verification_code: args.verificationCode ?? "enjoy-enough-outwit-win",
    next_step:
      args.nextStep ??
      "stripe login --complete 'https://dashboard.stripe.com/stripecli/auth/poll-token'",
  });
}

describe("parseStripeCliAuthStartOutput", () => {
  it("parses valid non-interactive JSON output", () => {
    expect(parseStripeCliAuthStartOutput(startOutput())).toStrictEqual({
      browserUrl:
        "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
      pollUrl: "https://dashboard.stripe.com/stripecli/auth/poll-token",
      verificationCode: "enjoy-enough-outwit-win",
    });
  });

  it("rejects invalid JSON", () => {
    expect(() => {
      parseStripeCliAuthStartOutput("{");
    }).toThrow();
  });

  it("rejects missing browser URL", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        JSON.stringify({
          verification_code: "code",
          next_step:
            "stripe login --complete https://dashboard.stripe.com/stripecli/auth/poll-token",
        }),
      );
    }).toThrow();
  });

  it("rejects missing verification code", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        JSON.stringify({
          browser_url:
            "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
          next_step:
            "stripe login --complete https://dashboard.stripe.com/stripecli/auth/poll-token",
        }),
      );
    }).toThrow();
  });

  it("rejects missing completion step", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        JSON.stringify({
          browser_url:
            "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
          verification_code: "code",
        }),
      );
    }).toThrow();
  });

  it("extracts a single-quoted completion URL", () => {
    const result = parseStripeCliAuthStartOutput(
      startOutput({
        nextStep:
          "stripe login --complete 'https://dashboard.stripe.com/stripecli/auth/single-quoted'",
      }),
    );

    expect(result.pollUrl).toBe(
      "https://dashboard.stripe.com/stripecli/auth/single-quoted",
    );
  });

  it("extracts a double-quoted completion URL", () => {
    const result = parseStripeCliAuthStartOutput(
      startOutput({
        nextStep:
          'stripe login --complete "https://dashboard.stripe.com/stripecli/auth/double-quoted"',
      }),
    );

    expect(result.pollUrl).toBe(
      "https://dashboard.stripe.com/stripecli/auth/double-quoted",
    );
  });

  it("extracts an unquoted completion URL", () => {
    const result = parseStripeCliAuthStartOutput(
      startOutput({
        nextStep:
          "stripe login --complete https://dashboard.stripe.com/stripecli/auth/unquoted",
      }),
    );

    expect(result.pollUrl).toBe(
      "https://dashboard.stripe.com/stripecli/auth/unquoted",
    );
  });

  it("rejects next_step without a complete URL", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        startOutput({ nextStep: "stripe login --help" }),
      );
    }).toThrow("Stripe CLI response did not include a completion URL");
  });

  it("rejects non-HTTPS completion URLs", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        startOutput({
          nextStep:
            "stripe login --complete http://dashboard.stripe.com/stripecli/auth/poll-token",
        }),
      );
    }).toThrow("Stripe CLI response included an unexpected completion URL");
  });

  it("rejects malformed completion URL arguments", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        startOutput({
          nextStep: "stripe login --complete not-a-url",
        }),
      );
    }).toThrow("Stripe CLI response included an invalid completion URL");
  });

  it("rejects non-Stripe completion URL hosts", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        startOutput({
          nextStep:
            "stripe login --complete https://example.com/stripecli/auth/poll-token",
        }),
      );
    }).toThrow("Stripe CLI response included an unexpected completion URL");
  });

  it("rejects unexpected Stripe dashboard completion paths", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        startOutput({
          nextStep:
            "stripe login --complete https://dashboard.stripe.com/settings",
        }),
      );
    }).toThrow("Stripe CLI response included an unexpected completion URL");
  });

  it("rejects non-Stripe browser URL hosts", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        startOutput({
          browserUrl: "https://example.com/stripecli/confirm_auth",
        }),
      );
    }).toThrow("Stripe CLI response included an unexpected browser URL");
  });

  it("rejects unexpected Stripe dashboard browser paths", () => {
    expect(() => {
      parseStripeCliAuthStartOutput(
        startOutput({ browserUrl: "https://dashboard.stripe.com/settings" }),
      );
    }).toThrow("Stripe CLI response included an unexpected browser URL");
  });

  it("accepts Stripe dashboard browser path children", () => {
    const browserUrl =
      "https://dashboard.stripe.com/stripecli/confirm_auth/start-token";

    expect(
      parseStripeCliAuthStartOutput(startOutput({ browserUrl })),
    ).toMatchObject({
      browserUrl,
    });
  });
});

describe("parseStripeCliAuthConfig", () => {
  it("parses a default restricted test mode key", () => {
    expect(
      parseStripeCliAuthConfig(
        `[default]
test_mode_api_key = "rk_test_abc123"
`,
        "test",
      ),
    ).toBe("rk_test_abc123");
  });

  it("parses a default secret test mode key", () => {
    expect(
      parseStripeCliAuthConfig(
        `[default]
test_mode_api_key = "sk_test_abc123"
`,
        "test",
      ),
    ).toBe("sk_test_abc123");
  });

  it("parses a default restricted live mode key", () => {
    expect(
      parseStripeCliAuthConfig(
        `[default]
live_mode_api_key = "rk_live_abc123"
`,
        "live",
      ),
    ).toBe("rk_live_abc123");
  });

  it("parses a default secret live mode key", () => {
    expect(
      parseStripeCliAuthConfig(
        `[default]
live_mode_api_key = "sk_live_abc123"
`,
        "live",
      ),
    ).toBe("sk_live_abc123");
  });

  it("returns only the selected mode key when both modes are present", () => {
    const config = `[default]
test_mode_api_key = "rk_test_selected"
live_mode_api_key = "rk_live_selected"
display_name = "Should not be returned"
`;

    expect(parseStripeCliAuthConfig(config, "test")).toBe("rk_test_selected");
    expect(parseStripeCliAuthConfig(config, "live")).toBe("rk_live_selected");
  });

  it("preserves top-level key fallback", () => {
    expect(
      parseStripeCliAuthConfig(
        `test_mode_api_key = "rk_test_topLevel"
`,
        "test",
      ),
    ).toBe("rk_test_topLevel");
  });

  it("rejects missing selected mode key", () => {
    expect(() => {
      parseStripeCliAuthConfig(
        `[default]
live_mode_api_key = "rk_live_only"
`,
        "test",
      );
    }).toThrow("Stripe CLI config did not contain a test mode API key");
  });

  it("rejects a key with the wrong mode prefix", () => {
    expect(() => {
      parseStripeCliAuthConfig(
        `[default]
test_mode_api_key = "rk_live_wrong"
`,
        "test",
      );
    }).toThrow("Stripe CLI config did not contain a test mode API key");
  });

  it("rejects a non-string selected mode key", () => {
    expect(() => {
      parseStripeCliAuthConfig(
        `[default]
test_mode_api_key = 123
`,
        "test",
      );
    }).toThrow("Stripe CLI config did not contain a test mode API key");
  });

  it("rejects malformed TOML", () => {
    const parseMalformed = () => {
      parseStripeCliAuthConfig("[default", "test");
    };

    expect(parseMalformed).toThrow("Stripe CLI config is not valid TOML");
  });

  it("rejects malformed TOML without leaking config values", () => {
    const parseMalformed = () => {
      parseStripeCliAuthConfig(
        `[default]
test_mode_api_key = "sk_test_should_not_leak"
bad =
`,
        "test",
      );
    };

    expect(parseMalformed).toThrow("Stripe CLI config is not valid TOML");
    expect(parseMalformed).not.toThrow(/sk_test_should_not_leak/);
  });
});

describe("redactStripeCliAuthText", () => {
  it("redacts bare Stripe restricted and secret keys", () => {
    const redacted = redactStripeCliAuthText(
      "rk_test_abc123 sk_test_def456 rk_live_ghi789 sk_live_placeholder_key",
    );

    expect(redacted).not.toContain("rk_test_abc123");
    expect(redacted).not.toContain("sk_test_def456");
    expect(redacted).not.toContain("rk_live_ghi789");
    expect(redacted).not.toContain("sk_live_placeholder_key");
    expect(redacted).toBe("[redacted] [redacted] [redacted] [redacted]");
  });

  it("redacts assignment-style secrets through sandbox redaction", () => {
    const redacted = redactStripeCliAuthText(
      "STRIPE_SECRET=sk_test_should_not_leak",
    );

    expect(redacted).toBe("STRIPE_SECRET=[redacted]");
  });

  it("redacts Stripe CLI auth URL tokens", () => {
    const redacted = redactStripeCliAuthText(
      "https://dashboard.stripe.com/stripecli/auth/poll-token",
    );

    expect(redacted).toBe("https://dashboard.stripe.com/stripecli/[redacted]");
    expect(redacted).not.toContain("poll-token");
  });

  it("redacts Stripe CLI confirm-auth URL tokens", () => {
    const redacted = redactStripeCliAuthText(
      "https://dashboard.stripe.com/stripecli/confirm_auth?t=start-token",
    );

    expect(redacted).toBe("https://dashboard.stripe.com/stripecli/[redacted]");
    expect(redacted).not.toContain("start-token");
  });
});

import { describe, expect, it } from "vitest";
import {
  acquisitionAttributionParams,
  readAttributionCookie,
  sourceType,
  writeAcquisitionAttributionCookie,
  type CookieJar,
} from "../lib/adAttribution";

function params(search: string): URLSearchParams {
  return new URLSearchParams(search);
}

// Emulates document.cookie: set() stores only the name=value pair (as a browser
// does, dropping attributes), get() returns the serialized jar. Raw writes are
// captured so attribute assertions are possible.
function fakeJar(): { jar: CookieJar; writes: string[] } {
  const cookies = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    jar: {
      get: () => {
        return [...cookies.entries()]
          .map(([k, v]) => {
            return `${k}=${v}`;
          })
          .join("; ");
      },
      set: (value: string) => {
        writes.push(value);
        const first = value.split(";")[0] ?? "";
        const eq = first.indexOf("=");
        cookies.set(first.slice(0, eq), first.slice(eq + 1));
      },
    },
  };
}

describe("sourceType", () => {
  it("classifies Google click ids as paid", () => {
    expect(sourceType(params("gclid=abc"), "google.com")).toBe("paid");
    expect(sourceType(params("gbraid=abc"), undefined)).toBe("paid");
    expect(sourceType(params("wbraid=abc"), undefined)).toBe("paid");
  });

  it("classifies paid utm mediums as paid", () => {
    expect(sourceType(params("utm_medium=cpc"), undefined)).toBe("paid");
    expect(sourceType(params("utm_medium=paid_social"), undefined)).toBe(
      "paid",
    );
  });

  it("classifies organic mediums and search referrers as organic_search", () => {
    expect(sourceType(params("utm_medium=organic"), undefined)).toBe(
      "organic_search",
    );
    expect(sourceType(params(""), "www.google.com")).toBe("organic_search");
    expect(sourceType(params(""), "bing.com")).toBe("organic_search");
  });

  it("classifies utm-tagged non-paid traffic as referral", () => {
    expect(sourceType(params("utm_source=newsletter"), undefined)).toBe(
      "referral",
    );
  });

  it("classifies no-param, no-referrer traffic as direct", () => {
    expect(sourceType(params(""), undefined)).toBe("direct");
  });

  it("classifies vm0.ai referrers as internal", () => {
    expect(sourceType(params(""), "app.vm0.ai")).toBe("internal");
  });

  it("falls back to referral for unknown external referrers", () => {
    expect(sourceType(params(""), "news.ycombinator.com")).toBe("referral");
  });
});

describe("acquisitionAttributionParams", () => {
  it("stamps source, classification, landing context, and forwarded ad params", () => {
    const result = acquisitionAttributionParams(
      "?gclid=abc&utm_source=google",
      {
        referrer: "https://www.google.com/",
        hostname: "www.vm0.ai",
        pathname: "/pricing",
      },
    );

    expect(result.get("vm0_source")).toBe("homepage");
    expect(result.get("source_type")).toBe("paid");
    expect(result.get("referrer_domain")).toBe("google.com");
    expect(result.get("landing_host")).toBe("vm0.ai");
    expect(result.get("landing_path")).toBe("/pricing");
    expect(result.get("gclid")).toBe("abc");
    expect(result.get("utm_source")).toBe("google");
  });

  it("omits absent optional fields", () => {
    const result = acquisitionAttributionParams("", {});
    expect(result.get("source_type")).toBe("direct");
    expect(result.has("referrer_domain")).toBe(false);
    expect(result.has("landing_host")).toBe(false);
  });
});

describe("writeAcquisitionAttributionCookie", () => {
  it("writes a first-touch .vm0.ai cookie with the expected attributes", () => {
    const { jar, writes } = fakeJar();

    const wrote = writeAcquisitionAttributionCookie(
      { hostname: "www.vm0.ai", pathname: "/", referrer: "" },
      "?gclid=abc",
      jar,
    );

    expect(wrote).toBe(true);
    expect(writes).toHaveLength(1);
    const raw = writes[0];
    expect(raw).toContain("Domain=.vm0.ai");
    expect(raw).toContain("Max-Age=7776000");
    expect(raw).toContain("SameSite=Lax");
    expect(raw).toContain("Secure");

    const value = readAttributionCookie(jar.get());
    expect(value).not.toBeNull();
    const parsed = new URLSearchParams(value ?? "");
    expect(parsed.get("source_type")).toBe("paid");
    expect(parsed.get("gclid")).toBe("abc");
  });

  it("does not overwrite an existing (first-touch) cookie", () => {
    const { jar, writes } = fakeJar();

    expect(
      writeAcquisitionAttributionCookie(
        { hostname: "www.vm0.ai" },
        "?utm_source=first",
        jar,
      ),
    ).toBe(true);
    expect(
      writeAcquisitionAttributionCookie(
        { hostname: "www.vm0.ai" },
        "?utm_source=second",
        jar,
      ),
    ).toBe(false);

    expect(writes).toHaveLength(1);
    const parsed = new URLSearchParams(readAttributionCookie(jar.get()) ?? "");
    expect(parsed.get("utm_source")).toBe("first");
  });

  it("uses a host-only cookie off the vm0.ai domain", () => {
    const { jar, writes } = fakeJar();

    writeAcquisitionAttributionCookie(
      { hostname: "localhost", pathname: "/" },
      "?utm_source=google",
      jar,
    );

    expect(writes[0]).not.toContain("Domain=");
  });
});

import { describe, expect, it } from "vitest";
import { writeAcquisitionAttributionCookie } from "../lib/adAttribution";
import { ACQUISITION_ATTRIBUTION_COOKIE } from "@vm0/api-contracts/contracts/zero-attribution";

interface CookieJar {
  get(): string;
  set(value: string): void;
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

function attributionParams(jar: CookieJar): URLSearchParams {
  const cookie = jar
    .get()
    .split(";")
    .map((part) => {
      return part.trim();
    })
    .find((part) => {
      return part.startsWith(`${ACQUISITION_ATTRIBUTION_COOKIE}=`);
    });

  expect(cookie).toBeDefined();
  return new URLSearchParams(
    decodeURIComponent(cookie?.split("=").slice(1).join("=") ?? ""),
  );
}

describe("writeAcquisitionAttributionCookie", () => {
  it.each([
    ["?gclid=abc", "https://www.google.com/", "paid"],
    ["?gbraid=abc", "", "paid"],
    ["?wbraid=abc", "", "paid"],
    ["?utm_medium=cpc", "", "paid"],
    ["?utm_medium=paid_social", "", "paid"],
    ["?utm_medium=organic", "", "organic_search"],
    ["", "https://www.google.com/", "organic_search"],
    ["", "https://bing.com/", "organic_search"],
    ["?utm_source=newsletter", "", "referral"],
    ["", "", "direct"],
    ["", "https://app.vm0.ai/", "internal"],
    ["", "https://news.ycombinator.com/", "referral"],
  ])("classifies %s / %s as %s", (landingSearch, referrer, sourceType) => {
    const { jar } = fakeJar();

    writeAcquisitionAttributionCookie(
      { hostname: "www.vm0.ai", referrer },
      landingSearch,
      jar,
    );

    expect(attributionParams(jar).get("source_type")).toBe(sourceType);
  });

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

    const parsed = attributionParams(jar);
    expect(parsed.get("vm0_source")).toBe("homepage");
    expect(parsed.get("source_type")).toBe("paid");
    expect(parsed.get("referrer_domain")).toBeNull();
    expect(parsed.get("landing_host")).toBe("vm0.ai");
    expect(parsed.get("landing_path")).toBe("/");
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
    const parsed = attributionParams(jar);
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

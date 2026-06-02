import { ACQUISITION_ATTRIBUTION_COOKIE } from "@vm0/api-contracts/contracts/zero-attribution";
import { describe, expect, it } from "vitest";
import {
  getStoredAdAttributionMetadata,
  recordAdAttribution,
} from "../ad-attribution.ts";

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => {
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => {
      for (const key of Array.from(map.keys())) {
        map.delete(key);
      }
    },
    key: (index) => {
      return Array.from(map.keys())[index] ?? null;
    },
    get length() {
      return map.size;
    },
  } as Storage;
}

function cookie(value: string): string {
  return `${ACQUISITION_ATTRIBUTION_COOKIE}=${encodeURIComponent(value)}`;
}

describe("recordAdAttribution", () => {
  it("captures attribution from the current URL query", () => {
    const storage = memoryStorage();
    recordAdAttribution(
      new URLSearchParams("?source_type=paid&gclid=abc"),
      storage,
      "",
    );
    const meta = getStoredAdAttributionMetadata(storage);
    expect(meta?.source_type).toBe("paid");
    expect(meta?.gclid).toBe("abc");
  });

  it("is first-touch: does not overwrite once captured", () => {
    const storage = memoryStorage();
    recordAdAttribution(new URLSearchParams("?utm_source=first"), storage, "");
    recordAdAttribution(new URLSearchParams("?utm_source=second"), storage, "");
    expect(getStoredAdAttributionMetadata(storage)?.utm_source).toBe("first");
  });

  it("falls back to the shared .vm0.ai cookie when the URL has none", () => {
    const storage = memoryStorage();
    recordAdAttribution(
      new URLSearchParams(""),
      storage,
      cookie("source_type=organic_search&utm_source=newsletter"),
    );
    const meta = getStoredAdAttributionMetadata(storage);
    expect(meta?.source_type).toBe("organic_search");
    expect(meta?.utm_source).toBe("newsletter");
  });

  it("prefers URL params over the cookie", () => {
    const storage = memoryStorage();
    recordAdAttribution(
      new URLSearchParams("?utm_source=url"),
      storage,
      cookie("utm_source=cookie"),
    );
    expect(getStoredAdAttributionMetadata(storage)?.utm_source).toBe("url");
  });

  it("records nothing when neither URL nor cookie carry attribution", () => {
    const storage = memoryStorage();
    recordAdAttribution(new URLSearchParams(""), storage, "");
    expect(getStoredAdAttributionMetadata(storage)).toBeUndefined();
  });
});

describe("getStoredAdAttributionMetadata", () => {
  it("maps params, flags click ids, and drops invalid source_type", () => {
    const storage = memoryStorage();
    recordAdAttribution(
      new URLSearchParams(
        "?source_type=bogus&gclid=abc&utm_source=google&vm0_source=homepage",
      ),
      storage,
      "",
    );
    const meta = getStoredAdAttributionMetadata(storage);
    expect(meta?.source_type).toBeUndefined();
    expect(meta?.gclid).toBe("abc");
    expect(meta?.gclid_present).toBe("true");
    expect(meta?.utm_source).toBe("google");
    expect(meta?.vm0_source).toBe("homepage");
  });
});

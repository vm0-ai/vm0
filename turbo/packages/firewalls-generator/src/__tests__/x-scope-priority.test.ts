import { describe, it, expect } from "vitest";
import { pickPrimaryScope, scopePriority } from "../x";

describe("scopePriority", () => {
  it("returns priority for known scopes", () => {
    expect(scopePriority("tweet.write", "test")).toBe(100);
    expect(scopePriority("like.read", "test")).toBe(50);
    expect(scopePriority("tweet.read", "test")).toBe(5);
    expect(scopePriority("users.read", "test")).toBe(5);
  });

  it("throws on unknown scope", () => {
    expect(() => scopePriority("unknown.scope", "GET /2/foo")).toThrow(
      'Unknown scope "unknown.scope" on GET /2/foo',
    );
  });
});

describe("pickPrimaryScope", () => {
  it("returns the only scope for single-scope endpoints", () => {
    expect(pickPrimaryScope(["tweet.read"], "GET /2/tweets/{id}")).toBe(
      "tweet.read",
    );
  });

  it("picks write scope over read scopes", () => {
    expect(
      pickPrimaryScope(
        ["tweet.read", "tweet.write", "users.read"],
        "POST /2/tweets",
      ),
    ).toBe("tweet.write");
  });

  it("picks like.write for like endpoints", () => {
    expect(
      pickPrimaryScope(
        ["like.write", "tweet.read", "users.read"],
        "POST /2/users/{id}/likes",
      ),
    ).toBe("like.write");
  });

  it("picks specific read over base read scopes", () => {
    expect(
      pickPrimaryScope(
        ["dm.read", "tweet.read", "users.read"],
        "GET /2/dm_events",
      ),
    ).toBe("dm.read");
  });

  it("breaks tweet.read vs users.read tie by path: /2/tweets → tweet.read", () => {
    expect(
      pickPrimaryScope(["tweet.read", "users.read"], "GET /2/tweets/{id}"),
    ).toBe("tweet.read");
  });

  it("breaks tweet.read vs users.read tie by path: /2/tweets/search/recent → tweet.read", () => {
    expect(
      pickPrimaryScope(
        ["tweet.read", "users.read"],
        "GET /2/tweets/search/recent",
      ),
    ).toBe("tweet.read");
  });

  it("breaks tweet.read vs users.read tie by path: /2/users → users.read", () => {
    expect(
      pickPrimaryScope(["tweet.read", "users.read"], "GET /2/users/me"),
    ).toBe("users.read");
  });

  it("breaks tie for /2/communities path → users.read", () => {
    expect(
      pickPrimaryScope(
        ["tweet.read", "users.read"],
        "GET /2/communities/search",
      ),
    ).toBe("users.read");
  });

  it("throws on unknown scope", () => {
    expect(() =>
      pickPrimaryScope(["tweet.read", "future.scope"], "GET /2/foo"),
    ).toThrow('Unknown scope "future.scope"');
  });

  it("throws on unresolvable priority tie", () => {
    expect(() =>
      pickPrimaryScope(["tweet.read", "users.read"], "GET /2/unknown/path"),
    ).toThrow("Priority tie");
  });
});

import { describe, expect, it } from "vitest";

import { pickSlackPermissionOwners } from "../slack";

describe("pickSlackPermissionOwners", () => {
  it("uses vm0-owned owners for shared Slack conversation scopes", () => {
    expect(
      pickSlackPermissionOwners("conversations.info", [
        "groups:read",
        "im:read",
        "mpim:read",
        "channels:read",
      ]),
    ).toStrictEqual(["conversations:read"]);

    expect(
      pickSlackPermissionOwners("conversations.history", [
        "groups:history",
        "channels:history",
        "mpim:history",
        "im:history",
      ]),
    ).toStrictEqual(["conversations:history"]);
  });

  it("keeps official scope owners for methods without overrides", () => {
    expect(
      pickSlackPermissionOwners("chat.postMessage", [
        "chat:write",
        "chat:write",
      ]),
    ).toStrictEqual(["chat:write"]);
  });

  it("throws when a shared Slack method's official scopes change", () => {
    expect(() => {
      pickSlackPermissionOwners("conversations.info", [
        "channels:read",
        "groups:read",
      ]);
    }).toThrow(
      'Slack method "conversations.info" owner override scopes changed',
    );
  });
});

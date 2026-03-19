import { describe, it, expect, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { fetchSlackUserInfo } from "../client";

function createMockClient(
  usersInfoResponse: Record<string, unknown>,
): WebClient {
  return {
    users: {
      info: vi.fn().mockResolvedValue(usersInfoResponse),
    },
  } as unknown as WebClient;
}

describe("Feature: Fetch Slack User Info", () => {
  it("should return structured user info with display name and timezone", async () => {
    const client = createMockClient({
      ok: true,
      user: {
        id: "U123",
        name: "jdoe",
        real_name: "Jane Doe",
        profile: {
          display_name: "Jane",
          real_name: "Jane Doe",
        },
        tz: "America/Los_Angeles",
        tz_label: "Pacific Standard Time",
      },
    });

    const result = await fetchSlackUserInfo(client, "U123");

    expect(result).toEqual({
      id: "U123",
      name: "Jane",
      email: undefined,
      timezone: "Pacific Standard Time",
    });
  });

  it("should fall back to real_name when display_name is empty", async () => {
    const client = createMockClient({
      ok: true,
      user: {
        id: "U456",
        real_name: "Bob Smith",
        profile: {
          display_name: "",
          real_name: "Bob Smith",
        },
        tz: "UTC",
      },
    });

    const result = await fetchSlackUserInfo(client, "U456");

    expect(result).toEqual({
      id: "U456",
      name: "Bob Smith",
      email: undefined,
      timezone: "UTC",
    });
  });

  it("should return undefined when API returns ok: false", async () => {
    const client = createMockClient({
      ok: false,
      error: "user_not_found",
    });

    const result = await fetchSlackUserInfo(client, "U999");

    expect(result).toBeUndefined();
  });

  it("should return undefined when user is missing", async () => {
    const client = createMockClient({
      ok: true,
      user: undefined,
    });

    const result = await fetchSlackUserInfo(client, "U999");

    expect(result).toBeUndefined();
  });

  it("should omit name when no name fields are available", async () => {
    const client = createMockClient({
      ok: true,
      user: {
        id: "U789",
        profile: {},
      },
    });

    const result = await fetchSlackUserInfo(client, "U789");

    expect(result).toEqual({
      id: "U789",
      name: undefined,
      email: undefined,
      timezone: undefined,
    });
  });

  it("should include email when available", async () => {
    const client = createMockClient({
      ok: true,
      user: {
        id: "U101",
        profile: {
          display_name: "Alice",
          email: "alice@example.com",
        },
        tz_label: "Eastern Time",
      },
    });

    const result = await fetchSlackUserInfo(client, "U101");

    expect(result).toEqual({
      id: "U101",
      name: "Alice",
      email: "alice@example.com",
      timezone: "Eastern Time",
    });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import {
  createTestRequest,
  clearOrgMembersCacheEntry,
} from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  generateZeroToken,
  generateSandboxToken,
} from "../../../../../../src/lib/auth/sandbox-token";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/connectors/connectors";

const context = testContext();

function searchConnectors(keyword?: string, token?: string) {
  const url = keyword
    ? `http://localhost:3000/api/zero/connectors/search?keyword=${encodeURIComponent(keyword)}`
    : "http://localhost:3000/api/zero/connectors/search";
  return GET(
    createTestRequest(
      url,
      token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    ),
  );
}

describe("GET /api/zero/connectors/search", () => {
  beforeEach(() => {
    context.setupMocks();
    mockClerk({ userId: "test-user-connectors-search" });
  });

  it("should return 401 when not authenticated", async () => {
    mockClerk({ userId: null });
    const response = await searchConnectors();
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error.code).toBe("UNAUTHORIZED");
  });

  it("should return connectors array with correct shape", async () => {
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.connectors).toBeInstanceOf(Array);
    expect(data.connectors.length).toBeGreaterThan(0);
    for (const connector of data.connectors) {
      expect(connector).toHaveProperty("id");
      expect(connector).toHaveProperty("label");
      expect(connector).toHaveProperty("description");
      expect(connector).toHaveProperty("authMethods");
      expect(typeof connector.id).toBe("string");
      expect(typeof connector.label).toBe("string");
      expect(typeof connector.description).toBe("string");
      expect(connector.authMethods).toBeInstanceOf(Array);
    }
  });

  it("should filter connectors by keyword matching label", async () => {
    // "GitHub" is a well-known connector without feature flag
    const response = await searchConnectors("GitHub");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.connectors.length).toBeGreaterThan(0);
    for (const connector of data.connectors) {
      const matchesLabel = connector.label.toLowerCase().includes("github");
      const matchesDescription = connector.description
        .toLowerCase()
        .includes("github");
      expect(matchesLabel || matchesDescription).toBe(true);
    }
  });

  it("should filter connectors by keyword matching description", async () => {
    // Search for a term likely found in descriptions but not labels
    const response = await searchConnectors("slack");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.connectors.length).toBeGreaterThan(0);
    for (const connector of data.connectors) {
      const matchesLabel = connector.label.toLowerCase().includes("slack");
      const matchesDescription = connector.description
        .toLowerCase()
        .includes("slack");
      expect(matchesLabel || matchesDescription).toBe(true);
    }
  });

  it("should return empty array for non-matching keyword", async () => {
    const response = await searchConnectors("zzz_no_match_zzz");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.connectors).toEqual([]);
  });

  it("should perform case-insensitive keyword search", async () => {
    const responseLower = await searchConnectors("github");
    const responseUpper = await searchConnectors("GITHUB");
    expect(responseLower.status).toBe(200);
    expect(responseUpper.status).toBe(200);
    const dataLower = await responseLower.json();
    const dataUpper = await responseUpper.json();
    expect(dataLower.connectors.length).toBe(dataUpper.connectors.length);
  });

  it("should hide feature-flagged connectors without api-token for non-enabled users", async () => {
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();

    // computer only has a feature-gated "api" auth method.
    // A random test user won't have the flag enabled, so it should be hidden
    const computer = data.connectors.find((c: { id: string }) => {
      return c.id === "computer";
    });
    expect(computer).toBeUndefined();
  });

  it("should show ungated api-token while hiding feature-gated oauth", async () => {
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();

    // neon gates oauth but leaves api-token available.
    // Even with flag disabled, it should be visible with only api-token
    const neon = data.connectors.find((c: { id: string }) => {
      return c.id === "neon";
    });
    expect(neon).toBeDefined();
    expect(neon.authMethods).toContain("api-token");
    // oauth should NOT be included since its feature flag is disabled.
    expect(neon.authMethods).not.toContain("oauth");
  });

  it("should hide feature-flagged connector when feature is disabled", async () => {
    mockClerk({
      userId: "random-non-staff-user",
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();

    // computer only has a feature-gated auth method, and the flag is disabled.
    const computer = data.connectors.find((c: { id: string }) => {
      return c.id === "computer";
    });
    expect(computer).toBeUndefined();
  });

  it("should include connectors with at least one ungated auth method", async () => {
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();

    const unflaggedTypes = (
      Object.keys(CONNECTOR_TYPES) as ConnectorType[]
    ).filter((type) => {
      return Object.values(CONNECTOR_TYPES[type].authMethods).some((method) => {
        return !method.featureFlag;
      });
    });
    expect(unflaggedTypes.length).toBeGreaterThan(0);

    for (const type of unflaggedTypes) {
      const found = data.connectors.find((c: { id: string }) => {
        return c.id === type;
      });
      expect(found).toBeDefined();
    }
  });

  it("exposes openai as api-token only", async () => {
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();
    const openai = data.connectors.find((c: { id: string }) => {
      return c.id === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai.authMethods).toEqual(["api-token"]);
  });

  it("hides zapier when its api-token auth method is feature-gated", async () => {
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();

    const zapier = data.connectors.find((c: { id: string }) => {
      return c.id === "zapier";
    });
    expect(zapier).toBeUndefined();
  });

  it("accepts a ZERO_TOKEN carrying the connector:read capability", async () => {
    const user = await context.setupUser();
    await clearOrgMembersCacheEntry(user.orgId, user.userId);
    const token = await generateZeroToken(user.userId, "run-1", user.orgId);

    const response = await searchConnectors(undefined, token);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.connectors).toBeInstanceOf(Array);
    expect(data.connectors.length).toBeGreaterThan(0);
  });

  it("rejects a sandbox token lacking the connector:read capability with 403", async () => {
    const user = await context.setupUser();
    const token = await generateSandboxToken(user.userId, "run-1", user.orgId);

    const response = await searchConnectors(undefined, token);
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error.code).toBe("FORBIDDEN");
  });
});

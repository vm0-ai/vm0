import { describe, it, expect, beforeEach } from "vitest";
import { GET } from "../route";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import { testContext } from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import {
  CONNECTOR_TYPES,
  type ConnectorType,
} from "@vm0/core/contracts/connectors";

const context = testContext();

function searchConnectors(keyword?: string) {
  const url = keyword
    ? `http://localhost:3000/api/zero/connectors/search?keyword=${encodeURIComponent(keyword)}`
    : "http://localhost:3000/api/zero/connectors/search";
  return GET(createTestRequest(url));
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

    // computer has a feature flag and only "api" auth (no api-token, no oauth)
    // A random test user won't have the flag enabled, so it should be hidden
    const computer = data.connectors.find((c: { id: string }) => {
      return c.id === "computer";
    });
    expect(computer).toBeUndefined();
  });

  it("should show feature-flagged connector with api-token even when flag is disabled", async () => {
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();

    // neon has a feature flag AND api-token auth method
    // Even with flag disabled, it should be visible with only api-token
    const neon = data.connectors.find((c: { id: string }) => {
      return c.id === "neon";
    });
    expect(neon).toBeDefined();
    expect(neon.authMethods).toContain("api-token");
    // oauth should NOT be included since the feature flag is disabled
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

    // computer has a feature flag (ComputerConnector) that is disabled
    const computer = data.connectors.find((c: { id: string }) => {
      return c.id === "computer";
    });
    expect(computer).toBeUndefined();
  });

  it("should include connectors without feature flags", async () => {
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();

    // Find a connector without a feature flag (e.g., github)
    const unflaggedTypes = (
      Object.keys(CONNECTOR_TYPES) as ConnectorType[]
    ).filter((type) => {
      return !CONNECTOR_TYPES[type].featureFlag;
    });
    expect(unflaggedTypes.length).toBeGreaterThan(0);

    for (const type of unflaggedTypes) {
      const found = data.connectors.find((c: { id: string }) => {
        return c.id === type;
      });
      expect(found).toBeDefined();
    }
  });

  it("exposes openai platform auth method for staff orgs", async () => {
    // Staff orgId hash is in STAFF_ORG_ID_HASHES, so the PlatformConnectors
    // feature switch fires automatically and `platform` surfaces alongside
    // `api-token` in the response.
    mockClerk({
      userId: "staff-user-openai-platform",
      orgId: "org_3ANttyrbWYJk6JKRSTRLEsbsDLe",
    });
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();
    const openai = data.connectors.find((c: { id: string }) => {
      return c.id === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai.authMethods).toEqual(
      expect.arrayContaining(["api-token", "platform"]),
    );
  });

  it("hides openai platform auth method for non-staff orgs", async () => {
    // Non-staff default: the PlatformConnectors gate is off, so `platform`
    // is filtered out and the connector looks identical to pre-skeleton.
    mockClerk({
      userId: "non-staff-user-openai-platform",
      orgId: "org_non_staff_openai",
    });
    const response = await searchConnectors();
    expect(response.status).toBe(200);
    const data = await response.json();
    const openai = data.connectors.find((c: { id: string }) => {
      return c.id === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai.authMethods).toEqual(["api-token"]);
  });
});

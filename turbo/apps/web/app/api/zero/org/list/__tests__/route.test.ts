import { describe, it, expect, beforeEach } from "vitest";
import { createTestRequest } from "../../../../../../src/__tests__/api-test-helpers";
import {
  testContext,
  uniqueId,
} from "../../../../../../src/__tests__/test-helpers";
import { mockClerk } from "../../../../../../src/__tests__/clerk-mock";
import { GET } from "../route";

const context = testContext();

describe("GET /api/zero/org/list", () => {
  beforeEach(async () => {
    context.setupMocks();
    await context.setupUser();
  });

  it("returns 401 when not authenticated", async () => {
    mockClerk({ userId: null });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/org/list",
    );
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("returns list of user orgs", async () => {
    const request = createTestRequest(
      "http://localhost:3000/api/zero/org/list",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.orgs).toBeInstanceOf(Array);
    expect(data.orgs.length).toBeGreaterThanOrEqual(1);
    expect(data.orgs[0]).toHaveProperty("slug");
    expect(data.orgs[0]).toHaveProperty("role");
  });

  it("returns multiple orgs when user belongs to several", async () => {
    const userId = uniqueId("multi-org");
    mockClerk({
      userId,
      clerkOrgs: [
        {
          id: "org_1",
          slug: "team-alpha",
          name: "Team Alpha",
          role: "org:admin",
        },
        {
          id: "org_2",
          slug: "team-beta",
          name: "Team Beta",
          role: "org:member",
        },
      ],
    });

    const request = createTestRequest(
      "http://localhost:3000/api/zero/org/list",
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.orgs).toHaveLength(2);
    expect(data.orgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "team-alpha", role: "admin" }),
        expect.objectContaining({ slug: "team-beta", role: "member" }),
      ]),
    );
  });
});

import { describe, it, expect } from "vitest";
import { GET, DELETE } from "../route";

describe("GET /api/credentials/:name - Endpoint Removed", () => {
  it("should return 410 Gone with upgrade message", async () => {
    const response = GET();
    const data = await response.json();

    expect(response.status).toBe(410);
    expect(data.error.code).toBe("ENDPOINT_REMOVED");
    expect(data.error.message).toContain("has been removed");
    expect(data.error.message).toContain("/api/secrets");
  });
});

describe("DELETE /api/credentials/:name - Endpoint Removed", () => {
  it("should return 410 Gone with upgrade message", async () => {
    const response = DELETE();
    const data = await response.json();

    expect(response.status).toBe(410);
    expect(data.error.code).toBe("ENDPOINT_REMOVED");
    expect(data.error.message).toContain("has been removed");
    expect(data.error.message).toContain("/api/secrets");
  });
});

import { describe, it, expect } from "vitest";
import { GET, HEAD } from "../route";

describe("retired /docs catch-all", () => {
  it("returns 410 Gone with HTML body on GET", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(410);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(body).toContain("This page has been removed");
  });

  it("returns 410 Gone with empty body on HEAD", async () => {
    const response = HEAD();
    const body = await response.text();

    expect(response.status).toBe(410);
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(body).toBe("");
  });
});

import { describe, expect, it } from "vitest";

describe("platform Btest harness", () => {
  it("runs in Chromium with native layout and shared MSW handlers", async () => {
    const scroller = document.createElement("div");
    scroller.style.height = "120px";
    scroller.style.overflow = "auto";

    const content = document.createElement("div");
    content.style.height = "480px";
    scroller.appendChild(content);
    document.body.appendChild(scroller);

    try {
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);

      const response = await fetch("http://localhost:3000/api/zero/org");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "org_1",
      });
    } finally {
      scroller.remove();
    }
  });
});

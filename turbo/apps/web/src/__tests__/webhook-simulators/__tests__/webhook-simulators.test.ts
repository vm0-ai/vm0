import { describe, it, expect, vi } from "vitest";
import { invokeCron } from "../cron";

describe("webhook-simulators", () => {
  describe("cron", () => {
    it("invokeCron passes auth header to handler", async () => {
      const handler = vi
        .fn()
        .mockResolvedValue(new Response("OK", { status: 200 }));
      const response = await invokeCron(handler);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();

      const request = handler.mock.calls[0]![0] as Request;
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toMatch(/^Bearer .+$/);
    });
  });
});

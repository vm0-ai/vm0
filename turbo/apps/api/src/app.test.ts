import app from "./app";

describe("api app", () => {
  it("responds from the Hono app", async () => {
    const response = await app.request("/");

    await expect(response.text()).resolves.toBe("Hello Hono!");
    expect(response.status).toBe(200);
  });
});

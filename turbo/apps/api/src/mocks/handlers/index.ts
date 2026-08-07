import { HttpResponse, http, type HttpHandler } from "msw";

export const handlers: readonly HttpHandler[] = [
  http.post(
    "https://api.axiom.co/v1/datasets/:dataset/ingest",
    async ({ request }) => {
      const body: unknown = await request.json();
      const ingested = Array.isArray(body) ? body.length : 0;
      return HttpResponse.json({
        ingested,
        failed: 0,
        processedBytes: 0,
        blocksCreated: 0,
        walLength: 0,
      });
    },
  ),
  http.get("https://chatgpt.com/backend-api/wham/usage", () => {
    return HttpResponse.json({});
  }),
];

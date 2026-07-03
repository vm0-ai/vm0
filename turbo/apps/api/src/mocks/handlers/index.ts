import { HttpResponse, http, type HttpHandler } from "msw";

export const handlers: readonly HttpHandler[] = [
  http.get("https://chatgpt.com/backend-api/wham/usage", () => {
    return HttpResponse.json({});
  }),
];

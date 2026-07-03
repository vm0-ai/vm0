import { http, HttpResponse } from "msw";

export const npmRegistryHandlers = [
  http.get("https://registry.npmjs.org/*/latest", () => {
    return HttpResponse.json({ version: "4.11.0" });
  }),
];

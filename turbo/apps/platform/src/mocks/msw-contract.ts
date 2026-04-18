/**
 * Contract-driven MSW helper.
 *
 * Wraps an MSW handler around a ts-rest contract route so that the path,
 * method, path params, query params, request body, and response shape are
 * all derived from the contract itself. Returning a body that doesn't match
 * the contract's declared response schema for the given status becomes a
 * TypeScript error at the call site.
 *
 * Scope note: introduced as the foundation helper for #9707. Phase 0 adds
 * typed `params`/`query`/`body` to the handler context on top of the Phase
 * pilot (path + method + response). Ably event orchestration and multipart
 * bodies are still out of scope.
 */
import type {
  AppRoute,
  AppRouteMutation,
  ServerInferRequest,
  ServerInferResponseBody,
  ServerInferResponses,
} from "@ts-rest/core";
import { http, HttpResponse, type HttpHandler, type PathParams } from "msw";

type AnyResponse<R extends AppRoute> = ServerInferResponses<R>;

type Respond<R extends AppRoute> = <
  Status extends keyof R["responses"] & number,
>(
  ...args: ServerInferResponseBody<R, Status> extends undefined
    ? [status: Status]
    : [status: Status, body: ServerInferResponseBody<R, Status>]
) => AnyResponse<R>;

type InferredRequest<R extends AppRoute> = ServerInferRequest<R>;

type InferParams<R extends AppRoute> = "params" extends keyof InferredRequest<R>
  ? InferredRequest<R>["params"]
  : PathParams;

type InferQuery<R extends AppRoute> = "query" extends keyof InferredRequest<R>
  ? InferredRequest<R>["query"]
  : Record<string, string>;

type InferBody<R extends AppRoute> = R extends AppRouteMutation
  ? "body" extends keyof InferredRequest<R>
    ? InferredRequest<R>["body"]
    : undefined
  : undefined;

type MockHandler<R extends AppRoute> = (ctx: {
  params: InferParams<R>;
  query: InferQuery<R>;
  body: InferBody<R>;
  request: Request;
  respond: Respond<R>;
}) => AnyResponse<R> | Promise<AnyResponse<R>>;

const methodMap = {
  GET: http.get,
  POST: http.post,
  PUT: http.put,
  PATCH: http.patch,
  DELETE: http.delete,
} as const;

export function mockApi<R extends AppRoute>(
  route: R,
  handler: MockHandler<R>,
): HttpHandler {
  const register = methodMap[route.method];
  // msw shares ts-rest's `:param` path syntax; prefix with `*` to match any origin.
  const pattern = `*${route.path}`;
  const respond: Respond<R> = (...args) => {
    const [status, body] = args;
    return { status, body } as AnyResponse<R>;
  };
  return register(pattern, async ({ params, request }) => {
    const url = new URL(request.url);
    const rawQuery = Object.fromEntries(url.searchParams.entries());
    // Apply Zod coercion and defaults from the contract's query schema when
    // present (e.g. `z.coerce.number().default(20)` for `limit`).
    const querySchema = route.query as
      | { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
      | undefined;
    const parsed =
      querySchema && typeof querySchema.safeParse === "function"
        ? querySchema.safeParse(rawQuery)
        : undefined;
    const query = (parsed?.success ? parsed.data : rawQuery) as InferQuery<R>;

    let body = undefined as InferBody<R>;
    if (route.method !== "GET") {
      const text = await request.clone().text();
      if (text.length > 0) {
        body = JSON.parse(text) as InferBody<R>;
      }
    }

    const result = await handler({
      params: params as InferParams<R>,
      query,
      body,
      request,
      respond,
    });
    if (result.body === null || result.body === undefined) {
      return new HttpResponse(null, { status: result.status });
    }
    return HttpResponse.json(result.body, { status: result.status });
  });
}

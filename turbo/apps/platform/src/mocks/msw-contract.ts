/**
 * Contract-driven MSW helper.
 *
 * Wraps an MSW handler around a ts-rest contract route so that the path,
 * method, and response shape are all derived from the contract itself.
 * Returning a body that doesn't match the contract's declared response
 * schema for the given status becomes a TypeScript error at the call site.
 *
 * Scope note: this is the pilot helper introduced for #9707. It covers
 * path + method + response typing. Query/body parsing and Ably event
 * orchestration are intentionally out of scope here.
 */
import type {
  AppRoute,
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

type MockHandler<R extends AppRoute> = (ctx: {
  params: PathParams;
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
    const result = await handler({ params, request, respond });
    if (result.body === null || result.body === undefined) {
      return new HttpResponse(null, { status: result.status });
    }
    return HttpResponse.json(result.body, { status: result.status });
  });
}

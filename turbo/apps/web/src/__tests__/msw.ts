import {
  http as mswHttp,
  type HttpHandler,
  type HttpResponseResolver,
} from "msw";
import type {
  DefaultBodyType,
  HttpRequestHandler,
  PathParams,
  RequestHandlerOptions,
} from "msw";
import { type Mock, vi } from "vitest";

type HttpRequestPredicate<Params extends PathParams> = Parameters<
  typeof mswHttp.post<Params, DefaultBodyType, DefaultBodyType>
>[0];

function wrapMswHandler(handler: HttpRequestHandler) {
  return <
    Params extends PathParams<keyof Params> = PathParams,
    RequestBodyType extends DefaultBodyType = DefaultBodyType,
    ResponseBodyType extends DefaultBodyType = undefined,
  >(
    predicate: HttpRequestPredicate<Params>,
    resolver: HttpResponseResolver<Params, RequestBodyType, ResponseBodyType>,
    options?: RequestHandlerOptions,
  ): {
    handler: HttpHandler;
    mocked: Mock<
      HttpResponseResolver<Params, RequestBodyType, ResponseBodyType>
    >;
  } => {
    const wrappedResolver: HttpResponseResolver<
      Params,
      RequestBodyType,
      ResponseBodyType
    > = (info) => {
      return resolver({
        ...info,
        request: info.request.clone(),
      });
    };

    const mocked = vi.fn(wrappedResolver);

    return {
      handler: handler(predicate, mocked, options),
      mocked,
    };
  };
}

export const http = {
  post: wrapMswHandler(mswHttp.post),
  get: wrapMswHandler(mswHttp.get),
  put: wrapMswHandler(mswHttp.put),
  delete: wrapMswHandler(mswHttp.delete),
};

export function handlers<
  T extends Record<
    string,
    { handler: HttpHandler; mocked: Mock<HttpResponseResolver> }
  >,
>(
  mockedHandlers: T,
): {
  mocked: { [K in keyof T]: T[K]["mocked"] };
  handlers: HttpHandler[];
} {
  const mocks = {} as { [K in keyof T]: T[K]["mocked"] };
  for (const key of Object.keys(mockedHandlers) as Array<keyof T>) {
    mocks[key] = mockedHandlers[key]!.mocked;
  }
  return {
    mocked: mocks,
    handlers: Object.values(mockedHandlers).map((h) => h.handler),
  };
}

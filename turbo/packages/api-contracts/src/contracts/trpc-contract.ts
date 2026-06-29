import {
  initTRPC,
  type AnyProcedure,
  type inferProcedureInput,
  type inferProcedureOutput,
} from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create({
  allowOutsideOfServer: true,
  isServer: !("window" in globalThis),
});

const noBodySymbol: unique symbol = Symbol("vm0.noBody");
const typeSymbol: unique symbol = Symbol("vm0.type");

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface NoBodyMarker {
  readonly [noBodySymbol]: true;
}

export interface TypeMarker<T> {
  readonly [typeSymbol]: T;
}

interface ZodLikeResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: { readonly issues: readonly unknown[] };
}

export interface ZodLikeSchema<T = unknown> {
  readonly safeParse: (input: unknown) => ZodLikeResult<T>;
}

type ContractSchema<T = unknown> =
  | z.ZodType<T>
  | ZodLikeSchema<T>
  | TypeMarker<T>
  | NoBodyMarker;

interface ResponseWithBody<TBody = unknown> {
  readonly contentType?: string;
  readonly body: ContractSchema<TBody>;
}

type ResponseSchema<TBody = unknown> =
  | ContractSchema<TBody>
  | ResponseWithBody<TBody>;

type ResponseMap = Record<number, ResponseSchema>;

export interface AppRouteSpec {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers?: ContractSchema;
  readonly query?: ContractSchema;
  readonly pathParams?: ContractSchema;
  readonly body?: ContractSchema;
  readonly contentType?: string;
  readonly responses: ResponseMap;
  readonly summary?: string;
}

type SchemaOutput<T> =
  T extends z.ZodType<infer Output>
    ? Output
    : T extends ZodLikeSchema<infer Output>
      ? Output
      : T extends TypeMarker<infer Output>
        ? Output
        : T extends NoBodyMarker
          ? undefined
          : never;

type SchemaInput<T> = T extends z.ZodType
  ? z.input<T>
  : T extends ZodLikeSchema<infer Output>
    ? Output
    : T extends TypeMarker<infer Output>
      ? Output
      : T extends NoBodyMarker
        ? undefined
        : never;

type EmptyObject = Record<never, never>;

type ResponseBody<T> = T extends { readonly body: infer Body }
  ? SchemaOutput<Body>
  : SchemaOutput<T>;

type ResponseUnion<TResponses extends ResponseMap> = {
  readonly [Status in keyof TResponses & number]: {
    readonly status: Status;
    readonly body: ResponseBody<TResponses[Status]>;
  };
}[keyof TResponses & number];

type AddRequestPart<
  TKey extends string,
  TSchema,
> = TSchema extends ContractSchema
  ? SchemaOutput<TSchema> extends undefined
    ? { readonly [Key in TKey]?: undefined }
    : { readonly [Key in TKey]: SchemaOutput<TSchema> }
  : Record<never, never>;

type AddClientRequestPart<
  TKey extends string,
  TSchema,
> = TSchema extends ContractSchema
  ? SchemaInput<TSchema> extends undefined
    ? { readonly [Key in TKey]?: SchemaInput<TSchema> }
    : EmptyObject extends SchemaInput<TSchema>
      ? { readonly [Key in TKey]?: SchemaInput<TSchema> }
      : { readonly [Key in TKey]: SchemaInput<TSchema> }
  : Record<never, never>;

type ServerRouteRequest<TSpec extends AppRouteSpec> = AddRequestPart<
  "params",
  TSpec["pathParams"]
> &
  AddRequestPart<"query", TSpec["query"]> &
  AddRequestPart<"body", TSpec["body"]> &
  AddRequestPart<"headers", TSpec["headers"]> & {
    readonly extraHeaders?: Record<string, string>;
    readonly fetchOptions?: RequestInit;
  };

type ClientRouteRequest<TSpec extends AppRouteSpec> = AddClientRequestPart<
  "params",
  TSpec["pathParams"]
> &
  AddClientRequestPart<"query", TSpec["query"]> &
  AddClientRequestPart<"body", TSpec["body"]> &
  AddClientRequestPart<"headers", TSpec["headers"]> & {
    readonly extraHeaders?: Record<string, string>;
    readonly fetchOptions?: RequestInit;
  };

type ClientRouteInput<TSpec extends AppRouteSpec> =
  EmptyObject extends ClientRouteRequest<TSpec>
    ? ClientRouteRequest<TSpec> | undefined
    : ClientRouteRequest<TSpec>;

export type AppRoute<TSpec extends AppRouteSpec = AppRouteSpec> = TSpec & {
  readonly procedure: AnyProcedure;
};

export type AppRouteMutation = AppRoute<{
  readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly responses: ResponseMap;
}>;

export type AppRouter = Record<string, AppRoute>;

export interface ApiFetcherArgs {
  readonly path: string;
  readonly method: HttpMethod;
  readonly headers: NonNullable<RequestInit["headers"]>;
  readonly body?: NonNullable<RequestInit["body"]>;
  readonly route: AppRoute;
  readonly fetchOptions?: RequestInit;
}

export type ApiFetcher = (args: ApiFetcherArgs) => Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}>;

export interface InitClientArgs {
  readonly baseUrl: string;
  readonly baseHeaders?: Record<string, string>;
  readonly jsonQuery?: boolean;
  readonly throwOnUnknownStatus?: boolean;
  readonly validateResponse?: boolean;
  readonly api?: ApiFetcher;
}

export type ServerInferRequest<R extends AppRoute> =
  R extends AppRoute<infer Spec> ? ServerRouteRequest<Spec> : never;

export type ServerInferResponses<R extends AppRoute> = inferProcedureOutput<
  R["procedure"]
>;

export type ClientInferResponses<R extends AppRoute> =
  ServerInferResponses<R> & {
    readonly headers: Headers;
  };

export type ServerInferResponseBody<R extends AppRoute, Status extends number> =
  Extract<ServerInferResponses<R>, { readonly status: Status }> extends {
    readonly body: infer Body;
  }
    ? Body
    : undefined;

type ClientInferRequest<R extends AppRoute> = inferProcedureInput<
  R["procedure"]
>;

type ClientMethod<R extends AppRoute> =
  undefined extends ClientInferRequest<R>
    ? (args?: ClientInferRequest<R>) => Promise<ClientInferResponses<R>>
    : (args: ClientInferRequest<R>) => Promise<ClientInferResponses<R>>;

export type InitClientReturn<
  TContract extends AppRouter,
  TArgs,
> = TArgs extends unknown
  ? {
      readonly [Key in keyof TContract]: TContract[Key] extends AppRoute
        ? ClientMethod<TContract[Key]>
        : never;
    }
  : never;

function isNoBody(value: unknown): value is NoBodyMarker {
  return typeof value === "object" && value !== null && noBodySymbol in value;
}

function isTypeMarker(value: unknown): value is TypeMarker<unknown> {
  return typeof value === "object" && value !== null && typeSymbol in value;
}

function isZodLikeSchema(value: unknown): value is ZodLikeSchema {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { readonly safeParse: unknown }).safeParse === "function"
  );
}

function responseBodySchema(response: ResponseSchema): ContractSchema {
  if (typeof response === "object" && response !== null && "body" in response) {
    return response.body;
  }

  return response;
}

function validateSchema(schema: ContractSchema, body: unknown): unknown {
  if (isNoBody(schema)) {
    return body;
  }

  if (isTypeMarker(schema)) {
    return body;
  }

  if (!isZodLikeSchema(schema)) {
    return body;
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error(
      `Response validation failed: ${JSON.stringify(result.error?.issues ?? [])}`,
    );
  }

  return result.data;
}

function isFrameworkErrorResponse(response: ResponseForValidation): boolean {
  if (response.status < 500) {
    return false;
  }

  if (typeof response.body === "string") {
    return true;
  }

  return (
    typeof response.body === "object" &&
    response.body !== null &&
    "error" in response.body &&
    typeof response.body.error === "string"
  );
}

interface ResponseForValidation {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Headers;
}

export function validateResponse<
  R extends AppRoute,
  TResponse extends ResponseForValidation,
>(args: { readonly appRoute: R; readonly response: TResponse }): TResponse {
  const response = args.response;
  const schema = args.appRoute.responses[response.status];
  if (!schema) {
    return args.response;
  }

  let body: unknown;
  try {
    body = validateSchema(responseBodySchema(schema), response.body);
  } catch (error) {
    if (isFrameworkErrorResponse(response)) {
      return response;
    }
    throw error;
  }
  return { ...response, body };
}

function createProcedure<TSpec extends AppRouteSpec>(spec: TSpec) {
  type Input = ClientRouteInput<TSpec>;
  type Output = ResponseUnion<TSpec["responses"]>;
  const procedure = t.procedure
    .input(z.custom<Input>())
    .output(z.custom<Output>());

  const resolver = (): never => {
    throw new Error("Contract procedures are type carriers only");
  };

  return spec.method === "GET"
    ? procedure.query(resolver)
    : procedure.mutation(resolver);
}

type RouteFromSpec<TSpec extends AppRouteSpec> = TSpec & {
  readonly procedure: ReturnType<typeof createProcedure<TSpec>>;
};

type RouterFromSpec<TSpec extends Record<string, AppRouteSpec>> = {
  readonly [Key in keyof TSpec]: RouteFromSpec<TSpec[Key]>;
};

export function initContract(): {
  readonly router: <TSpec extends Record<string, AppRouteSpec>>(
    spec: TSpec,
  ) => RouterFromSpec<TSpec>;
  readonly noBody: () => NoBodyMarker;
  readonly otherResponse: <TResponse extends ResponseWithBody>(
    response: TResponse,
  ) => TResponse;
  readonly type: <T>() => TypeMarker<T>;
} {
  return {
    router: (spec) => {
      const router = Object.fromEntries(
        Object.entries(spec).map(([name, route]) => {
          return [name, { ...route, procedure: createProcedure(route) }];
        }),
      );
      return router as RouterFromSpec<typeof spec>;
    },
    noBody: () => {
      return { [noBodySymbol]: true };
    },
    otherResponse: (response) => {
      return response;
    },
    type: <T>() => {
      return { [typeSymbol]: undefined as T };
    },
  };
}

function appendQuery(url: URL, query: unknown): void {
  if (typeof query !== "object" || query === null) {
    return;
  }

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }

    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null) {
        continue;
      }
      url.searchParams.append(key, String(item));
    }
  }
}

function applyPathParams(path: string, params: unknown): string {
  if (typeof params !== "object" || params === null) {
    return path;
  }

  return Object.entries(params).reduce((current, [key, value]) => {
    return current.replace(`:${key}`, encodeURIComponent(String(value)));
  }, path);
}

function isBodyInit(value: unknown): value is NonNullable<RequestInit["body"]> {
  return (
    typeof value === "string" ||
    value instanceof Blob ||
    value instanceof FormData ||
    value instanceof URLSearchParams ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  );
}

function createRequestBody(body: unknown): {
  readonly body?: NonNullable<RequestInit["body"]>;
  readonly contentType?: string;
} {
  if (body === undefined) {
    return {};
  }

  if (isBodyInit(body)) {
    return { body };
  }

  return {
    body: JSON.stringify(body),
    contentType: "application/json",
  };
}

function mergeHeaders(
  config: InitClientArgs,
  args: {
    readonly headers?: unknown;
    readonly extraHeaders?: Record<string, string>;
  },
  contentType?: string,
): Headers {
  const headers = new Headers(config.baseHeaders);
  if (args.headers && typeof args.headers === "object") {
    for (const [key, value] of Object.entries(args.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      }
    }
  }
  for (const [key, value] of Object.entries(args.extraHeaders ?? {})) {
    headers.set(key, value);
  }
  if (contentType && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }
  return headers;
}

function parseResponseBody(response: Response): Promise<unknown> | undefined {
  if (
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  ) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  if (contentType.startsWith("text/")) {
    return response.text();
  }

  return response.blob();
}

export async function trpcRestFetchApi(args: ApiFetcherArgs): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}> {
  const response = await fetch(args.path, {
    ...args.fetchOptions,
    method: args.method,
    headers: args.headers,
    body: args.body,
  });

  return {
    status: response.status,
    body: await parseResponseBody(response),
    headers: response.headers,
  };
}

function responseStatusIsKnown(route: AppRoute, status: number): boolean {
  return Object.hasOwn(route.responses, status);
}

export function initClient<TContract extends AppRouter>(
  contract: TContract,
  config: InitClientArgs,
): InitClientReturn<TContract, InitClientArgs> {
  const client = Object.fromEntries(
    Object.entries(contract).map(([name, route]) => {
      const callRoute = async (input?: unknown) => {
        const requestInput =
          typeof input === "object" && input !== null
            ? (input as {
                readonly params?: unknown;
                readonly query?: unknown;
                readonly body?: unknown;
                readonly headers?: unknown;
                readonly extraHeaders?: Record<string, string>;
                readonly fetchOptions?: RequestInit;
              })
            : {};
        const path = applyPathParams(route.path, requestInput.params);
        const url = new URL(path, config.baseUrl);
        appendQuery(url, requestInput.query);
        const body = createRequestBody(requestInput.body);
        const headers = mergeHeaders(config, requestInput, body.contentType);
        const fetcher = config.api ?? trpcRestFetchApi;
        const result = await fetcher({
          path: url.toString(),
          method: route.method,
          headers,
          body: body.body,
          route,
          fetchOptions: requestInput.fetchOptions,
        });

        if (
          config.throwOnUnknownStatus &&
          !responseStatusIsKnown(route, result.status)
        ) {
          throw new Error(
            `Unknown response status ${result.status} for ${route.method} ${route.path}`,
          );
        }

        if (config.validateResponse) {
          return validateResponse({
            appRoute: route,
            response: result as ServerInferResponses<typeof route>,
          });
        }

        return result;
      };

      return [name, callRoute];
    }),
  );

  return client as InitClientReturn<TContract, InitClientArgs>;
}

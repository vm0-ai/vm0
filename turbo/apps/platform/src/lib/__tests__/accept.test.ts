import * as Sentry from "@sentry/react";
import { toast } from "@vm0/ui/components/ui/sonner";
import { describe, expect, it, vi } from "vitest";
import { ApiError, accept } from "../accept";

vi.mock("@sentry/react", () => {
  return { addBreadcrumb: vi.fn() };
});

vi.mock("@vm0/ui/components/ui/sonner", () => {
  return { toast: { error: vi.fn() } };
});

describe("accept", () => {
  it("accepted status → returns result, no toast, no throw", async () => {
    const response = { status: 200 as const, body: { id: "x" } };
    const result = await accept(Promise.resolve(response), [200]);
    expect(result).toStrictEqual(response);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("multiple accepted codes → both pass through", async () => {
    const response200 = { status: 200 as const, body: { id: "a" } };
    const response201 = { status: 201 as const, body: { id: "b" } };
    type TwoStatuses =
      | { status: 200; body: { id: string } }
      | { status: 201; body: { id: string } };

    const result200 = await accept(
      Promise.resolve(response200) as Promise<TwoStatuses>,
      [200],
    );
    expect(result200).toStrictEqual(response200);

    const result201 = await accept(
      Promise.resolve(response201) as Promise<TwoStatuses>,
      [201],
    );
    expect(result201).toStrictEqual(response201);
  });

  it("unaccepted status with standard error body → toast + throw with server message", async () => {
    type OkOrBad =
      | { status: 200; body: { id: string } }
      | { status: 400; body: { error: { message: string; code: string } } };
    const response: OkOrBad = {
      status: 400,
      body: { error: { message: "Bad input", code: "BAD_REQUEST" } },
    };

    await expect(accept(Promise.resolve(response), [200])).rejects.toSatisfy(
      (err: unknown) => {
        return (
          err instanceof ApiError &&
          err.message === "Bad input" &&
          err.code === "BAD_REQUEST" &&
          err.status === 400
        );
      },
    );
    expect(toast.error).toHaveBeenCalledWith("Bad input");
  });

  it("unaccepted status with non-standard body → fallback message", async () => {
    type OkOrFail =
      | { status: 200; body: { id: string } }
      | { status: 500; body: null };
    const response: OkOrFail = { status: 500, body: null };

    await expect(accept(Promise.resolve(response), [200])).rejects.toSatisfy(
      (err: unknown) => {
        return (
          err instanceof ApiError &&
          err.message === "HTTP 500" &&
          err.status === 500
        );
      },
    );
    expect(toast.error).toHaveBeenCalledWith("HTTP 500");
  });

  it("{ toast: false } → no toast, still throws", async () => {
    type OkOrForbidden =
      | { status: 200; body: { id: string } }
      | { status: 403; body: { error: { message: string; code: string } } };
    const response: OkOrForbidden = {
      status: 403,
      body: { error: { message: "Forbidden", code: "FORBIDDEN" } },
    };

    await expect(
      accept(Promise.resolve(response), [200], { toast: false }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("thrown error is instanceof ApiError with correct fields", async () => {
    type OkOrForbidden =
      | { status: 200; body: { id: string } }
      | { status: 403; body: { error: { message: string; code: string } } };
    const response: OkOrForbidden = {
      status: 403,
      body: { error: { message: "Forbidden", code: "FORBIDDEN" } },
    };

    await expect(accept(Promise.resolve(response), [200])).rejects.toSatisfy(
      (err: unknown) => {
        return (
          err instanceof ApiError &&
          err.code === "FORBIDDEN" &&
          err.status === 403 &&
          err.name === "ApiError"
        );
      },
    );
  });

  it("adds a warning breadcrumb for 4xx errors", async () => {
    type OkOrBad =
      | { status: 200; body: { id: string } }
      | { status: 400; body: { error: { message: string; code: string } } };
    const response: OkOrBad = {
      status: 400,
      body: { error: { message: "Bad input", code: "BAD_REQUEST" } },
    };

    await expect(
      accept(Promise.resolve(response), [200]),
    ).rejects.toBeInstanceOf(ApiError);
    expect(vi.mocked(Sentry.addBreadcrumb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.addBreadcrumb)).toHaveBeenCalledWith({
      category: "api",
      level: "warning",
      message: "API 400 BAD_REQUEST",
      data: { status: 400, code: "BAD_REQUEST" },
    });
  });

  it("adds an error breadcrumb for 5xx errors", async () => {
    type OkOrFail =
      | { status: 200; body: { id: string } }
      | { status: 500; body: null };
    const response: OkOrFail = { status: 500, body: null };

    await expect(
      accept(Promise.resolve(response), [200]),
    ).rejects.toBeInstanceOf(ApiError);
    expect(vi.mocked(Sentry.addBreadcrumb)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Sentry.addBreadcrumb)).toHaveBeenCalledWith({
      category: "api",
      level: "error",
      message: "API 500 UNKNOWN",
      data: { status: 500, code: "UNKNOWN" },
    });
  });

  it("does not add a breadcrumb for accepted responses", async () => {
    const response = { status: 200 as const, body: { id: "x" } };
    await accept(Promise.resolve(response), [200]);
    expect(vi.mocked(Sentry.addBreadcrumb)).not.toHaveBeenCalled();
  });
});

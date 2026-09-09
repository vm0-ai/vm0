const privateDetail = "private_prompt_history_authorization_canary";
const safeError = {
  code: "unsupported_value",
  param: "reasoning.effort",
} as const;

export const openRouterErrorFixtures = [
  {
    name: "direct code and parameter",
    body: { error: { ...safeError, message: privateDetail } },
    expected: {
      errorCode: "unsupported_value",
      errorParam: "reasoning.effort",
    },
  },
  {
    name: "numeric gateway code",
    body: { error: { code: 400, message: privateDetail } },
    expected: { errorCode: 400, errorParam: undefined },
  },
  {
    name: "bounded provider JSON",
    body: {
      error: {
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: { ...safeError, message: privateDetail },
          }),
          prompt: privateDetail,
          headers: { authorization: privateDetail },
        },
      },
    },
    expected: {
      errorCode: "unsupported_value",
      errorParam: "reasoning.effort",
    },
  },
  {
    name: "google provider status",
    body: {
      error: {
        code: 400,
        metadata: {
          raw: JSON.stringify({
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: privateDetail,
            },
          }),
        },
      },
    },
    expected: { errorCode: "INVALID_ARGUMENT", errorParam: undefined },
  },
  {
    name: "absent diagnostics",
    body: { error: { message: privateDetail } },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "unknown identifier-shaped sensitive fields",
    body: {
      error: {
        code: privateDetail,
        param: "messages",
        message: privateDetail,
        metadata: { error_type: privateDetail, history: privateDetail },
      },
    },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "malformed field types",
    body: {
      error: {
        code: { value: privateDetail },
        param: ["reasoning.effort"],
        metadata: [],
      },
    },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "oversized field values",
    body: { error: { code: "x".repeat(4097), param: "x".repeat(4097) } },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "malformed HTTP error JSON",
    body: `${privateDetail}: invalid JSON`,
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "malformed provider JSON",
    body: { error: { metadata: { raw: `{${privateDetail}` } } },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "oversized provider JSON",
    body: {
      error: {
        metadata: {
          raw: JSON.stringify({ error: safeError, padding: "x".repeat(4097) }),
        },
      },
    },
    expected: { errorCode: undefined, errorParam: undefined },
  },
  {
    name: "oversized HTTP error body",
    body: { error: { ...safeError, message: "x".repeat(65_537) } },
    expected: { errorCode: undefined, errorParam: undefined },
  },
] as const;

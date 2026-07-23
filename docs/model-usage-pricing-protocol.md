# Signed Model Usage Pricing Protocol

This document is the source of truth for the signed model usage pricing
response headers consumed by the runner mitm addon. It defines version 1 of the
contract between:

- the legacy pricing producer, which handled a VM0 Auto request and added the
  private pricing headers to its response;
- the runner mitm addon, which authenticates and consumes those headers; and
- the sandbox client, which receives the response after the private headers
  have been removed.

> **Retirement compatibility:** The Auto model no longer accepts new runs.
> This protocol and its guest-agent, runner, and proxy compatibility paths
> remain temporarily so runs claimed by a pre-retirement API deployment can
> drain safely. Remove them after all pre-retirement API and runner versions
> are no longer active or rollback-eligible.

The implementation lives in
`crates/runner/mitm-addon/src/model_usage_pricing.py`.

## Response Headers

The producer sends exactly one value for each response header:

| Header                          | Value                                      |
| ------------------------------- | ------------------------------------------ |
| `x-vm0-usage-pricing`           | A base64url-encoded version-1 JSON payload |
| `x-vm0-usage-pricing-signature` | A base64url-encoded HMAC-SHA256 digest     |

Header names are case-insensitive. Missing values and duplicate values are
rejected. The encoded pricing value must be non-empty ASCII and at most 2048
characters, inclusive.

The supported producer form uses the URL-safe base64 alphabet and omits `=`
padding. The runner accepts valid base64url values with or without padding for
both headers. Padding on the pricing value changes the bytes covered by the
HMAC, so the producer must sign the exact value it sends.

Only the producer forms described here are protocol guarantees. Producers must
not depend on additional JSON or base64 forms that a particular decoder
version may happen to accept.

## Version-1 Payload

The decoded pricing value is a JSON object with exactly these four fields:

```json
{
  "version": 1,
  "issuedAt": 1750000000,
  "unitSize": 1000000,
  "unitPrices": {
    "tokens.input": 0,
    "tokens.output": 0,
    "tokens.cache_read": 0,
    "tokens.cache_creation": 0
  }
}
```

The timestamp and zero prices illustrate the shape only. A real `issuedAt` must
use current Unix time within the freshness window. Pricing values are supplied
by the producer and are not defined by this document.

| Field           | Requirement                                           |
| --------------- | ----------------------------------------------------- |
| `version`       | The JSON integer `1`                                  |
| `issuedAt`      | A non-Boolean integer containing Unix time in seconds |
| `unitSize`      | A positive, non-Boolean integer                       |
| `unitPrices`    | An object with exactly the four keys shown above      |
| Each unit price | A non-negative, non-Boolean integer                   |

Each unit price is the number of gross credits per `unitSize` tokens for its
category. After aggregating one category's token quantity, the runner computes:

```text
grossCredits = ceil(quantity * unitPrice / unitSize)
```

The runner accepts `issuedAt` when its absolute difference from the runner's
current Unix time is at most 300 seconds. Both the past and future 300-second
boundaries are inclusive.

Producers encode the JSON as UTF-8 before applying base64url. JSON field order
and insignificant whitespace do not change the parsed schedule, but they do
change the encoded pricing value. The signature must therefore be calculated
after the producer has finalized the exact encoded value.

## Signature

The signature authenticates the exact pricing header for the request that
received it:

```text
key     = UTF8(request_bearer_token)
message = "vm0-model-usage-pricing-v1" || NUL || ASCII(encoded_pricing)
digest  = HMAC-SHA256(key, message)
header  = BASE64URL(digest)
```

`NUL` is one `0x00` byte. `encoded_pricing` is the complete
`x-vm0-usage-pricing` header value, including any padding. The runner decodes
the signature and compares it with the expected digest using a constant-time
comparison.

The request bearer token is credential material as well as the HMAC key. The
producer and runner must not log, persist, expose, or include it in protocol
diagnostics.

## Runner Acceptance And Header Removal

The runner accepts a schedule only when all of these conditions hold:

1. The response contains exactly one pricing value and one signature value.
2. The matched firewall is billable and has the exact identity
   `model-provider:vm0-model`.
3. The request contains exactly one `authorization` value. It starts with the
   case-sensitive prefix `Bearer ` and contains a non-empty token after
   surrounding whitespace is removed.
4. The encoded pricing value satisfies the ASCII and 2048-character limits.
5. The signature decodes and matches the expected HMAC.
6. The payload decodes and satisfies every version-1 field, freshness, and
   pricing constraint.

As soon as a response exists, the runner collects and removes every value of
both private response headers before applying these checks. The headers
therefore remain hidden from the sandbox client on both acceptance and
rejection, including duplicate-header rejection.

An accepted schedule is stored as primitive flow metadata and applied
atomically to every supported model usage category. A rejected schedule stores
no pricing metadata; partial schedules are never applied.

## Rejection And Billing Fallback

Pricing rejection does not reject the model response or drop its usage events.
The runner reports the usage without runner-calculated `grossCredits`. The API
then uses its existing exact or fallback pricing-table lookup. Missing or
fallback server pricing remains visible through the existing underbilling
classification and logging paths.

This fallback keeps usage reportable, but it is not a compatibility mechanism
for an uncoordinated protocol change: a new producer format rejected by an old
runner can select a different billing source.

## Compatibility And Versioning

Changes to schedule values and `issuedAt` remain version-1 data when they
satisfy the existing field and value constraints. Reordering JSON fields,
changing insignificant whitespace, or changing accepted base64url padding is
also compatible when the producer signs the exact emitted pricing value.

Changes to any of the following require explicit compatibility analysis and
normally a new payload version and signature domain:

- either response-header name or its cardinality;
- HMAC key derivation, algorithm, message, or domain;
- the payload field set, field types, or field semantics;
- the exact model usage category set;
- freshness, size, trust, rejection, or fallback semantics.

Runner and producer deployments are not atomic. An incompatible future version
must be rolled out in phases:

1. Prepare runners to accept both the existing and new versions.
2. Deploy the compatible runner and let older runners drain.
3. Migrate the producer to emit the new version.
4. Remove old-version acceptance only after old producers and runners can no
   longer overlap.

See [Deployment compatibility](./deployment-compatibility.md) for the
repository-wide rollout model.

## Keeping The Contract Aligned

Protocol changes must update this document, the implementation, and the
relevant conformance coverage together:

- `crates/runner/mitm-addon/src/model_usage_pricing.py` verifies and consumes
  the response headers.
- `crates/runner/mitm-addon/src/usage/model_pricing.py` validates the atomic
  pricing schedule used by model usage reporting.
- `crates/runner/mitm-addon/tests/model_provider_flow_helpers.py` is the test
  producer for valid signed schedules.
- `crates/runner/mitm-addon/tests/test_response_headers_handler.py` covers the
  public response-header hook.
- `crates/runner/mitm-addon/tests/test_model_provider_usage.py` covers signed
  pricing through final usage events.

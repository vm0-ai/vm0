# Pi native provider consumer preparation

This is the reader/runtime/accounting release for [#32803](https://github.com/vm0-ai/vm0/issues/32803), part of [#32795](https://github.com/vm0-ai/vm0/issues/32795). It does not admit a new production route or emit native model configs. The controller owns independent acceptance, authorized publication and the subsequent activation child.

## Two independent version axes

`PiModelConfig` generation 4 adds native Messages/SSE and Bedrock Converse/AWS event-stream readers. Generations 1, 2 and 3 keep their vocabulary, producers and behavior. Launch snapshot V3, Pi JSONL, memory admission, canonical owned-thread identity and source fencing are unchanged. An unknown model generation is left unclaimed; it is never coerced into a supported dialect.

| Consumer                                  | Prepared behavior                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| API contract and stored execution context | Strict native protocol, logical catalog, exact endpoint, selected credential bundle, ownership and one-attempt policy     |
| Runner claim API                          | Requires generation 4 advertisement plus the exact native egress context; missing/older capability leaves the job pending |
| Runner environment                        | Generated DTO plus strict refinements; only selected opaque native credential markers enter the guest                     |
| CLI and shared Pi runtime                 | Materialize the same route; API resolves explicit credentials, sandbox supplies markers                                   |
| API-first and sandbox AgentSession        | Reuse native adapters, tools, history, thinking signatures, images, compaction and cancellation                           |
| API-first billing                         | Read all five active Claude logical models using the existing immutable usage identities and canonical prices             |

Normal producers remain in `pi-sandbox-config.ts` and their existing launch paths. The chat caller, internal connector queue callback and workflow launch all retain `shouldUsePiExecution` and the current shared selection behavior. No availability/alias, cohort, default, entitlement or feature switch changes are included.

## Native transport and credentials

Messages supports existing Anthropic, managed/user OpenRouter, Vercel, custom Messages headers and Azure Foundry resource paths. Opaque deployment/profile IDs are independent of the trusted Claude catalog: the adapter constructs thinking/output behavior from the catalog and sends the configured upstream identifier only at the payload boundary. Official Claude OAuth/subscription credentials are rejected, including recognizable subscription tokens in custom-header material. No ambient Anthropic authentication is inherited.

Bedrock uses the pinned pi-ai adapter with a narrow typed `clientConfig` patch. The real AWS client receives the frozen region/endpoint, explicit bearer or SigV4 credentials, `maxAttempts: 1`, an owned request handler, and the caller cancellation signal. The client is destroyed on completion. Credentials are copied before passing to the SDK, which annotates credential objects. The shared agent loop is not copied.

The sandbox SigV4 client signs with fake markers; existing MITM `auth.awsSigv4` resolves and re-signs with real access key, secret and optional session token outside the guest. Bearer stays bearer. The compiled native firewall fixes one inference URL and the public-destination policy. API transport rejects redirects and validates the actual DNS addresses used by direct sockets; Runner enforces destination validation for proxied requests. Credential values are never embedded in the model contract.

## Accounting ownership

Native `input`, `output`, `cacheRead` and `cacheWrite` are disjoint provider quantities. The optional one-hour cache-create count remains a subset of cache creation and is never added again. Short cache retention preserves existing pricing; this change does not add TTL price categories or rewrite historical usage.

API-owned provider calls write through `recordPiApiFirstTurnUsage`; sandbox calls retain the proxy writer. Idempotent response/category identities are unchanged, including retries and late cancellation observations. Native user-owned credentials bypass Built-in model-token charges even if an obsolete billable marker is present. This does not waive tool, infrastructure or maintenance charges. Phase 2 keeps the #32626 proxy-only accounting path and its existing maintenance model/key owner; foreground native usage does not enter that path.

## Publication and activation gates

Follow [deployment compatibility](deployment-compatibility.md). Merge is not publication or native-route acceptance. Before the later activation child writes generation 4, independently verify all of these:

1. The preparation API is live and older API readers have drained. Retained API rollback targets must understand generation 4 and native Built-in usage before writers activate.
2. The selected Runner artifacts advertise generation 4 and pass strict native environment and existing MITM auth validation. Old Runners may remain but cannot claim generation 4 work.
3. Every CLI artifact that can be pinned in a new generation 4 sandbox reads this contract. A capable Runner paired with an old pinned CLI is not sufficient.
4. Existing generations, queued/stored contexts, API-first handoff, shared memory and Phase 2 billing remain healthy. Existing claimed guests retain the documented two-hour runtime plus bounded finalization window.
5. Activation connects shared policy/mapping/admission/writers only in the subsequent controller-owned issue. Rollback after activation must not select an API, Runner/CLI combination or retained artifact that cannot read already-written native contexts. Stop new native writers before any incompatible rollback and inventory queued/claimed work first.

There is no migration/backfill and no new permanent compatibility fallback. Existing Gen1/#31085 and #32783 compatibility debt remains under its existing owners and removal gates.

## Bounded production evidence

The parent records a fully paged MaskDB snapshot for `[2026-08-10T03:00:00Z, 2026-09-09T03:00:00Z)`: 32,699 unique relevant runs, 33 pages, final page 699. Active Built-in Claude: 912 in 30 days / 159 in 7 days. Excluded official Claude subscription: 13,333 / 3,524. Existing Built-in DeepSeek: 18,005 in 30 days; custom Responses DeepSeek: 398. Other new BYOK/cloud routes had zero observed runs; this is not a live pass.

The 03:04:33Z configuration census found DeepSeek 8, Anthropic API key 8, OpenRouter Claude 11, OpenRouter Codex 1, Vercel Claude 2 and subscription 38; no Bedrock/Foundry rows. Three custom Messages surfaces exist. These are bounded historical inventory, not current eligibility, complete traffic coverage, deployment proof or production acceptance.

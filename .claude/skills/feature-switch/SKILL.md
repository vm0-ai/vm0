---
name: feature-switch
description: Feature switch system guide for gating new user-facing features behind feature flags
---

# Feature Switch Skill

This skill documents the feature switch system and provides step-by-step instructions for adding new feature switches. **All new user-facing features must be gated behind a feature switch** for gradual rollout.

## When to Use

A feature switch is required when adding:
- New UI pages, sections, or sidebar navigation items
- New API endpoints exposed to users or agents
- New integrations (connectors, Slack, Telegram, etc.)
- New zero token capabilities

A feature switch is **not** required for:
- Internal refactors or code cleanup
- Test infrastructure changes
- Build/CI configuration
- Bug fixes to existing features
- Documentation updates

## How to Add a Feature Switch

### Step 1: Add a key to the enum

File: `turbo/packages/core/src/feature-switch-key.ts`

Add a new entry to `FeatureSwitchKey`:

```typescript
export enum FeatureSwitchKey {
  // ... existing keys
  MyFeature = "myFeature",
}
```

### Step 2: Register the switch

File: `turbo/packages/core/src/feature-switch.ts`

Add an entry to the `FEATURE_SWITCHES` record:

```typescript
[FeatureSwitchKey.MyFeature]: {
  maintainer: "you@vm0.ai",
  enabled: false,
  enabledOrgIdHashes: STAFF_ORG_ID_HASHES, // optional: staff-only access
},
```

**Configuration options:**

| Field | Type | Description |
|-------|------|-------------|
| `maintainer` | `string` | Email of the responsible person |
| `enabled` | `boolean` | `true` = on for everyone, `false` = off by default |
| `enabledUserHashes` | `string[]` | FNV-1a hashes of allowed user IDs |
| `enabledEmailHashes` | `string[]` | FNV-1a hashes of allowed emails |
| `enabledOrgIdHashes` | `string[]` | FNV-1a hashes of allowed org IDs |

**Common default states:**

- `enabled: false` — fully hidden until manually enabled via Lab page
- `enabled: false` + `enabledOrgIdHashes: STAFF_ORG_ID_HASHES` — staff-only (most common for new features)
- `enabled: true` — on for everyone (use when feature is ready for GA)

### Step 3: Gate the feature in application code

Choose the pattern that matches where your feature is consumed.

#### Server-side (API routes)

```typescript
import { isFeatureEnabled, FeatureSwitchKey } from "@vm0/core";

// In route handler:
if (!isFeatureEnabled(FeatureSwitchKey.MyFeature, { userId, orgId })) {
  return createErrorResponse("FORBIDDEN", "Feature not available");
}
```

#### Client-side (Platform UI)

```typescript
import { FeatureSwitchKey } from "@vm0/core";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";

// In component:
const features = useLastResolved(featureSwitch$);
const showMyFeature = features?.[FeatureSwitchKey.MyFeature] ?? false;

// Conditional rendering:
{showMyFeature && <MyFeatureComponent />}
```

#### Sidebar navigation gating

In `turbo/apps/platform/src/views/zero-page/zero-sidebar.tsx`, add a `featureGate` to the sidebar item:

```typescript
{
  id: "my-feature",
  label: "My Feature",
  icon: MyIcon,
  featureGate: FeatureSwitchKey.MyFeature,
}
```

#### Connector gating

In `turbo/packages/core/src/contracts/connectors.ts`, add `featureFlag` to the connector config:

```typescript
myConnector: {
  label: "My Connector",
  featureFlag: FeatureSwitchKey.MyConnector,
  // ...
}
```

#### Zero token capability gating

In `turbo/apps/api/src/signals/auth/tokens.ts`, add to `CONDITIONAL_CAPABILITIES`:

```typescript
const CONDITIONAL_CAPABILITIES: ReadonlyMap<ZeroCapability, FeatureSwitchKey> =
  new Map([
    // ... existing entries
    ["my-feature:write", FeatureSwitchKey.MyFeature],
  ]);
```

## Key Files

| File | Role |
|------|------|
| `turbo/packages/core/src/feature-switch-key.ts` | Enum of all feature switch keys |
| `turbo/packages/core/src/feature-switch.ts` | Registry and evaluation logic |
| `turbo/apps/platform/src/signals/external/feature-switch.ts` | Client-side reactive state with override layers |
| `turbo/apps/platform/src/views/zero-page/zero-sidebar.tsx` | Sidebar nav items with `featureGate` |
| `turbo/packages/core/src/contracts/connectors.ts` | Connector type definitions with `featureFlag` field |
| `turbo/apps/api/src/signals/auth/tokens.ts` | Token capability gating |

## Override Layers

Evaluation has two layers (lowest to highest priority):

1. **Core registry** — static config in source code, evaluated against `userId` / `email` / `orgId` hashes.
2. **Per-user DB overrides** — row in `user_feature_switches` keyed by `(orgId, userId)`. Written via the Lab page toggles or `window._vm0.featureSwitches.myFeature = true` (both call `POST /api/zero/feature-switches`). Cleared via the Lab page "Reset all" button (`DELETE /api/zero/feature-switches`).

The same two-layer resolution applies on the server: route handlers that call `isFeatureEnabled(..., { userId, orgId, overrides })` pass overrides loaded via `loadFeatureSwitchOverrides(orgId, userId)`.

There is **no** client-only layer. `window._vm0.featureSwitches` requires auth and persists across refreshes; there is no device-local override.

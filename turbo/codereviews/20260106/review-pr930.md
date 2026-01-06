# Code Review: PR #930 - Official Runner Support

## Summary

This PR implements official runner support for `vm0/*` groups, enabling shared runners deployed on vm0 infrastructure to poll and execute jobs from any user.

## Commits Reviewed

1. **f6a517c3** - feat(runner): add official runner support for vm0/\* groups
2. **11239b5b** - fix(ci): add OFFICIAL_RUNNER_SECRET to Vercel deployment env
3. **6ecedaad** - fix: format claim route
4. **d2b4bff6** - refactor(ci): switch E2E tests to official runner

## Overall Assessment: APPROVED

The implementation is clean, well-structured, and follows project patterns. The security considerations (timing-safe comparison) are properly addressed.

---

## Detailed Review

### 1. Authentication Module (`runner-auth.ts`)

**Strengths:**

- Clean separation of authentication types via discriminated union (`RunnerAuthContext`)
- Proper use of `timingSafeEqual` to prevent timing attacks
- Clear token format differentiation (`vm0_official_*` vs `vm0_live_*`)
- Good logging for debugging authentication issues

**No Issues Found**

### 2. Scope Service Changes (`scope-service.ts`)

**Strengths:**

- Clean helper function `isOfficialRunnerGroup()` using existing `isSystemScope()`
- Proper early return for official groups in `validateRunnerGroupScope()`
- Clear documentation of the authorization logic

**No Issues Found**

### 3. Poll/Claim Endpoints

**Strengths:**

- Clean branching logic based on `auth.type`
- Official runners restricted to `vm0/*` groups only
- User runners maintain existing scope validation

**No Issues Found**

### 4. Unit Tests (`runner-auth.test.ts`)

**Strengths:**

- 14 comprehensive tests covering all authentication scenarios
- Proper mocking of dependencies
- Tests for edge cases (missing secret, wrong secret, timing-safe comparison)

**Minor Note:**

- Lines 55-56, 63-64: Uses `eslint-disable` for `any` type casting on `globalThis`. This is acceptable for test mocking but noted for completeness.

### 5. CI Workflow Changes

**Strengths:**

- Simplified CI flow: runner starts in `deploy-runner` job
- Clean removal of separate official runner E2E tests (all tests now validate the feature)
- Proper secret propagation to Vercel deployment

**No Issues Found**

---

## Security Considerations

- **Timing-safe comparison**: Properly implemented using `crypto.timingSafeEqual`
- **Length check before comparison**: Returns early if lengths differ
- **Secret validation**: Returns `null` (unauthorized) for invalid secrets, not error details
- **Scope isolation**: Official runners can only access `vm0/*` groups

---

## Recommendations (Optional Improvements)

None required. The implementation is production-ready.

---

## Files Changed

| File                  | Changes                | Status        |
| --------------------- | ---------------------- | ------------- |
| `runner-auth.ts`      | New auth module        | Clean         |
| `runner-auth.test.ts` | 14 unit tests          | Comprehensive |
| `scope-service.ts`    | +2 functions           | Clean         |
| `poll/route.ts`       | Auth branching         | Clean         |
| `claim/route.ts`      | Auth branching         | Clean         |
| `turbo.yml`           | CI workflow refactor   | Clean         |
| `generate-config.sh`  | Official token support | Clean         |
| `env.ts`              | +1 env var             | Clean         |
| `turbo.json`          | +1 env var             | Clean         |

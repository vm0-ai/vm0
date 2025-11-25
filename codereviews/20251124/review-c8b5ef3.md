# Code Review: c8b5ef3

## Commit Info
- **Hash:** c8b5ef352fc85cff5d40aab05ba403f219aabb4e
- **Author:** Ethan Zhang
- **Message:** test: remove artificial delays from agent runs tests (#174)
- **Files Changed:** 2

## Summary
This commit removes artificial `setTimeout` delays from test mocks and replaces them with proper async handling using `vi.waitFor`. Also removes the obsolete `ESLINT_SUPPRESSION_AUDIT.md` file.

## Review Against Bad Code Smells

### 1. Mock Analysis
| Status | Details |
|--------|---------|
| OK | Mocks are simplified and no longer include artificial delays. |

### 2. Test Coverage
| Status | Details |
|--------|---------|
| GOOD | Test coverage maintained while improving test reliability. |

### 3. Error Handling
| Status | Details |
|--------|---------|
| GOOD | Error case mock uses `mockRejectedValue` which immediately rejects, better reflecting real behavior. |

### 4. Interface Changes
| Status | Details |
|--------|---------|
| NONE | No interface changes. |

### 5. Timer and Delay Analysis
| Status | Details |
|--------|---------|
| EXCELLENT | **This commit specifically addresses bad smell #10.** Removes 800ms+ of artificial delays including:
- `setTimeout` in mock implementations removed
- `await new Promise((resolve) => setTimeout(resolve, 100))` replaced with `vi.waitFor`
- Long-running test now uses never-resolving promise instead of 5s delay |

### 6. Dynamic Imports
| Status | Details |
|--------|---------|
| OK | No dynamic imports. |

### 7. Database Mocking in Web Tests
| Status | Details |
|--------|---------|
| GOOD | Tests use real database operations within `vi.waitFor` to check for status updates. This is the correct approach - verifying actual database state rather than mocking. |

### 8. Test Mock Cleanup
| Status | Details |
|--------|---------|
| OK | Existing cleanup patterns preserved. |

### 9. TypeScript `any` Type
| Status | Details |
|--------|---------|
| OK | No `any` types. |

### 10. Artificial Delays in Tests
| Status | Details |
|--------|---------|
| FIXED | **Primary purpose of this commit.** All artificial delays removed and replaced with proper async handling using `vi.waitFor`. |

### 11. Hardcoded URLs
| Status | Details |
|--------|---------|
| OK | No hardcoded URLs introduced. |

### 12. Direct DB Operations in Tests
| Status | Details |
|--------|---------|
| OK | Database reads used to verify state changes are appropriate in integration tests. |

### 13. Fallback Patterns
| Status | Details |
|--------|---------|
| OK | No fallback patterns. |

### 14. Lint/Type Suppressions
| Status | Details |
|--------|---------|
| OK | No suppression comments. Removes the `ESLINT_SUPPRESSION_AUDIT.md` file which is no longer needed. |

### 15. Bad Tests
| Status | Details |
|--------|---------|
| IMPROVED | Tests now properly wait for actual async operations to complete rather than relying on arbitrary delays. |

## Key Changes

### Before (Bad)
```typescript
mockRunService.executeRun.mockImplementation(
  (context: ExecutionContext) =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ ... });
      }, 100); // Artificial delay
    }),
);
// ...
await new Promise((resolve) => setTimeout(resolve, 500)); // Waiting with arbitrary timeout
```

### After (Good)
```typescript
mockRunService.executeRun.mockImplementation(
  async (context: ExecutionContext) => {
    return { ... }; // Immediate resolution
  },
);
// ...
await vi.waitFor(async () => {
  const [run] = await globalThis.services.db.select()...;
  expect(run?.status).toBe("completed");
}); // Proper async waiting
```

## Verdict
**APPROVED** - Excellent improvement that eliminates flaky test behavior and improves CI performance. Properly addresses bad smell #10 (Artificial Delays in Tests).

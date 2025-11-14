# Commit Message Examples

This document provides extensive examples of good and bad commit messages to help you write consistent, high-quality commits.

## Anatomy of a Good Commit Message

```
<type>[optional scope]: <description>  ← Title (under 100 chars)
                                       ← Blank line
[optional body explaining why]         ← Body (optional)
                                       ← Blank line
[optional footer(s)]                   ← Footer (optional)
```

## Quick Examples: Good vs Bad

### Example 1: New Feature

❌ **Bad:**
```
Add user authentication
```
**Problems:** Missing type, capitalized, missing details

✅ **Good:**
```
feat: add user authentication system
```
**Why good:** Clear type, lowercase, concise, describes what was added

---

### Example 2: Bug Fix

❌ **Bad:**
```
Fix: Resolve database connection timeout.
```
**Problems:** Capitalized type, capitalized description, period at end

✅ **Good:**
```
fix: resolve database connection timeout
```
**Why good:** Lowercase type and description, no period, clear and concise

---

### Example 3: Documentation

❌ **Bad:**
```
updated the api docs
```
**Problems:** Missing type, wrong tense

✅ **Good:**
```
docs(api): update endpoint documentation
```
**Why good:** Has type and scope, imperative mood, specific

---

### Example 4: Too Long

❌ **Bad:**
```
feat: Add user authentication system with OAuth2 integration, JWT tokens, refresh mechanism, and comprehensive error handling
```
**Problems:** 120 characters (over 100 limit), too much detail in title

✅ **Good:**
```
feat: add user authentication with oauth2

Implements JWT token-based authentication with refresh mechanism.
Includes comprehensive error handling for edge cases.
```
**Why good:** Concise title under 100 chars, details in body

---

## Feature Examples

### Adding New Functionality

✅ **Excellent:**
```
feat: add export to csv functionality
```

✅ **Excellent with scope:**
```
feat(reports): add export to csv functionality
```

✅ **Excellent with body:**
```
feat: add export to csv functionality

Allows users to export table data to CSV format.
Includes proper encoding for international characters.
```

❌ **Avoid:**
```
Added CSV export                        # Missing type, wrong tense
feat: CSV export                         # Not imperative, unclear
FEAT: add csv export                     # Type not lowercase
feat: Add CSV export                     # Description capitalized
feat: add csv export.                    # Period at end
```

### API Endpoints

✅ **Excellent:**
```
feat(api): add user profile endpoint
```

✅ **Excellent with details:**
```
feat(api): add user profile endpoint

GET /api/users/:id returns user profile data.
Includes avatar URL, bio, and public stats.
```

❌ **Avoid:**
```
New API endpoint                         # Missing type
feat: Added /api/users/:id               # Wrong tense
feat(api): Add user profile endpoint     # Description capitalized
```

### UI Components

✅ **Excellent:**
```
feat(ui): add dark mode toggle
```

✅ **Excellent:**
```
feat: add analytics dashboard widget
```

❌ **Avoid:**
```
feat(ui): Add Dark Mode Toggle           # Capitalized description
feat: dark mode                          # Not imperative, unclear
```

---

## Bug Fix Examples

### Resolving Issues

✅ **Excellent:**
```
fix: resolve database connection timeout
```

✅ **Excellent with scope:**
```
fix(auth): prevent token expiration edge case
```

✅ **Excellent with explanation:**
```
fix: handle null values in user profile

Prevents crash when optional profile fields are missing.
Adds fallback values for display.
```

❌ **Avoid:**
```
Fixed bug                                # Missing details, wrong tense
fix: Bug fix                             # Capitalized, too vague
FIX: resolve timeout                     # Type not lowercase
fix: Resolve timeout.                    # Capitalized description, period
```

### Validation Fixes

✅ **Excellent:**
```
fix: correct email validation regex
```

✅ **Excellent:**
```
fix(forms): prevent submission with invalid data
```

❌ **Avoid:**
```
fix validation                           # Not descriptive enough
fix: fixed email validation              # Wrong tense
fix: Email validation fix                # Capitalized
```

### Performance Fixes

✅ **Excellent:**
```
fix: optimize image loading performance
```

✅ **Excellent:**
```
fix(db): resolve n+1 query issue
```

❌ **Avoid:**
```
perf: fix slow images                    # Use fix: for bugs
fix: Images load slow                    # Capitalized
```

---

## Refactoring Examples

### Standard Refactoring (No Release)

✅ **Excellent:**
```
refactor: extract validation logic to separate module
```

✅ **Excellent:**
```
refactor(auth): simplify token refresh logic
```

❌ **Avoid:**
```
refactor: Simplify code                  # Capitalized, too vague
refactor: extracted validation           # Wrong tense
```

### Refactoring That Should Trigger Release

✅ **Excellent:**
```
fix: refactor authentication flow for improved security
```

✅ **Excellent:**
```
fix: refactor database queries for better performance

Restructures queries to reduce load time by 50%.
No API changes, fully backward compatible.
```

**Note:** Using `fix:` instead of `refactor:` triggers a patch release.

---

## Documentation Examples

✅ **Excellent:**
```
docs: update installation instructions
```

✅ **Excellent:**
```
docs(api): add examples for webhook endpoints
```

✅ **Excellent:**
```
docs: fix typo in contributing guide
```

❌ **Avoid:**
```
Update README                            # Missing type
docs: Updated README                     # Capitalized, wrong tense
docs: update readme.                     # Period at end
DOCS: update readme                      # Type not lowercase
```

---

## Test Examples

✅ **Excellent:**
```
test: add unit tests for user service
```

✅ **Excellent:**
```
test(e2e): add checkout flow tests
```

✅ **Excellent:**
```
test: fix flaky integration test
```

❌ **Avoid:**
```
Added tests                              # Missing type, wrong tense
test: Add tests                          # Capitalized
test: adding unit tests                  # Wrong tense
```

---

## CI/Build Examples

✅ **Excellent:**
```
ci: optimize release workflow dependencies
```

✅ **Excellent:**
```
chore: update build script for monorepo
```

✅ **Excellent:**
```
build: configure turborepo caching
```

❌ **Avoid:**
```
ci: Optimize workflow                    # Capitalized
Updated CI                               # Missing type
ci: optimizing workflow                  # Wrong tense
```

---

## Breaking Changes Examples

### Method 1: Using `!`

✅ **Excellent:**
```
feat!: change api response format to include metadata
```

✅ **Excellent with details:**
```
feat!: restructure user api endpoints

BREAKING CHANGE: User endpoints moved from /users to /api/v2/users.
Update client code to use new base path.
```

### Method 2: Using Footer

✅ **Excellent:**
```
refactor: restructure database schema

BREAKING CHANGE: User table column names have changed.
Run migration: npm run migrate:v2
```

❌ **Avoid:**
```
feat: BREAKING: change api                # Don't use BREAKING in title
feat: breaking change in api              # Use ! or footer
```

---

## Multi-Line Examples

### With Body Explanation

✅ **Excellent:**
```
feat: add rate limiting to api endpoints

Implements token bucket algorithm with 100 req/min limit.
Returns 429 status with Retry-After header when exceeded.
Configurable via RATE_LIMIT_MAX env variable.
```

### With Footer References

✅ **Excellent:**
```
fix: resolve memory leak in websocket connections

Properly cleans up event listeners on disconnect.
Reduces memory usage by ~40% under load.

Closes #1234
```

### Complex Change with Multiple Sections

✅ **Excellent:**
```
feat: add real-time notification system

Implements WebSocket-based notifications for:
- New messages
- System alerts
- Activity updates

Uses socket.io with Redis adapter for horizontal scaling.
Includes automatic reconnection with exponential backoff.

Closes #456, #789
```

---

## Scope Examples

Scopes add context about which part of the codebase changed:

✅ **Good Scope Usage:**
```
feat(api): add user endpoint
fix(auth): resolve token refresh issue
docs(readme): update installation steps
test(e2e): add checkout flow tests
refactor(db): optimize query performance
```

❌ **Unnecessary Scopes:**
```
feat(feature): add new feature          # Redundant
fix(bug): fix bug                       # Redundant
```

---

## Real-World Scenarios

### Scenario: Adding a New Page

✅ **Good:**
```
feat: add user settings page

Includes tabs for:
- Profile information
- Privacy settings
- Notification preferences

Uses shadcn/ui components for consistency.
```

### Scenario: Fixing a Critical Bug

✅ **Good:**
```
fix: prevent data loss on form submission

Adds validation before clearing form state.
Displays confirmation dialog for unsaved changes.

Fixes #2345
```

### Scenario: Updating Dependencies

✅ **Good:**
```
deps: update next.js to v14.2.0

Includes security patches and performance improvements.
No breaking changes in this update.
```

### Scenario: Improving Code Quality

✅ **Good (triggers release):**
```
fix: refactor error handling for better reliability

Standardizes error responses across all API endpoints.
Adds proper logging for debugging.
```

✅ **Good (no release):**
```
refactor: simplify component prop structure

Reduces prop drilling by using context.
No functional changes.
```

### Scenario: Adding Tests

✅ **Good:**
```
test: add comprehensive unit tests for auth service

Achieves 95% code coverage.
Includes edge cases for token expiration and refresh.
```

---

## Anti-Patterns to Avoid

### ❌ Vague Messages
```
fix: fix bug
feat: update code
chore: changes
```

### ❌ Wrong Capitalization
```
Fix: resolve issue
feat: Add feature
FEAT: add feature
feat: add Feature
```

### ❌ Wrong Tense
```
feat: added feature
fix: fixing bug
docs: updating readme
```

### ❌ Periods at End
```
feat: add feature.
fix: resolve bug.
```

### ❌ Too Long
```
feat: add comprehensive user authentication system with oauth2 integration and jwt token support including refresh tokens
```

### ❌ Missing Type
```
add user authentication
resolve database timeout
update documentation
```

### ❌ Console-Style Messages
```
wip: working on feature
temp: temporary fix
asdf: quick test
```

---

## Commit Message Checklist

Before committing, verify your message:

- [ ] Has valid type (`feat`, `fix`, `docs`, etc.)
- [ ] Type is lowercase
- [ ] Description starts with lowercase
- [ ] No period at the end of title
- [ ] Title is under 100 characters
- [ ] Uses imperative mood (add, fix, update)
- [ ] Describes "why" not just "what"
- [ ] Body (if present) explains motivation
- [ ] Footer (if present) references issues

## Quick Validation

Run this mental check:
1. Can someone understand what changed by reading the title?
2. Does it follow the format: `type: lowercase description`?
3. Is it under 100 characters?
4. Would I be proud to see this in the project history?

If yes to all → Great commit message! ✅

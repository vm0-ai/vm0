# PR #637 Code Review: Codex Support

## Summary

This PR adds comprehensive support for OpenAI Codex CLI alongside the existing Claude Code integration. The changes span across CLI, web, and core packages to enable provider-specific configurations, event parsing, and storage mount paths.

## Key Changes

### 1. Provider Configuration (`provider-config.ts`)

- **Good**: Clean abstraction with `ProviderDefaults` interface
- **Good**: Proper separation of production/development images
- **Codex config added**: `vm0/codex:latest` and `vm0/codex:dev`

### 2. Event Parser System

- **New**: `CodexEventParser` class for Codex JSONL event format
- **New**: `event-parser-factory.ts` with auto-detection of event format
- **Good**: Comprehensive event type handling (thread, turn, item events)
- **Good**: Excellent test coverage (250+ lines in codex-event-parser.test.ts)

### 3. Provider-Specific Mount Paths

- **Good**: `getInstructionsMountPath(provider)` - `~/.claude` vs `~/.codex`
- **Good**: `getSkillsBasePath(provider)` - `~/.claude/skills` vs `~/.codex/skills`
- **Good**: `getInstructionsFilename(provider)` - `CLAUDE.md` vs `AGENTS.md`

### 4. System Image Support (`scope-reference.ts`)

- **New**: `SYSTEM_IMAGE_CODEX = "codex"`
- **New**: `SYSTEM_IMAGES` array for validation
- **Good**: Updated `resolveSystemImageToE2b()` to support both providers
- **Good**: Legacy format warnings for `vm0-codex` and `vm0-codex-dev`

### 5. E2B Sandbox Templates

- **New**: `scripts/e2b/vm0-codex/` with build scripts and template

## Potential Issues

### Minor Issues

1. **Model hardcoded as "unknown"** in `CodexEventParser.parseThreadStarted()`:

   ```typescript
   model: "unknown", // Codex thread.started doesn't include model
   ```

   This is acceptable given the limitation, but could be improved by reading from environment.

2. **Duplicated GitHub URL parsing logic** - `parseGitHubTreeUrl` exists in both:
   - `turbo/apps/cli/src/lib/github-skills.ts`
   - `turbo/apps/web/src/lib/storage/storage-resolver.ts`
     Consider consolidating into `@vm0/core`.

### No Critical Issues Found

The code follows project conventions and has proper:

- Error handling patterns
- Type safety
- Test coverage
- Documentation comments

## Test Coverage

**Excellent coverage** with new test files:

- `codex-event-parser.test.ts` - 15 test cases
- `event-parser-factory.test.ts` - 12 test cases
- `provider-config.test.ts` - 14 test cases
- `system-storage.test.ts` - 4 test cases
- `storage-resolver.test.ts` - 47 total tests (new provider tests added)
- `scope-reference.spec.ts` - Extended with codex-specific tests

## Recommendations

1. **Consider abstracting provider paths into a single source of truth** - Currently provider-specific paths are defined in multiple places (CLI's `system-storage.ts` and web's `storage-resolver.ts`). A centralized `@vm0/core` utility would reduce duplication.

2. **Add validation for provider names** - The code defaults to claude-code for unknown providers silently. Consider logging a warning for unknown providers.

## Overall Assessment

**Approved** - This is a well-structured implementation that:

- Follows existing patterns consistently
- Has comprehensive test coverage
- Properly separates concerns between providers
- Maintains backward compatibility with existing Claude Code workflows

The PR is ready for merge after CI passes.

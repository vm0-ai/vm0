# Docs App Guidelines

## Commit Message Convention

**Use `feat(docs):` prefix for documentation changes** instead of `docs:`.

The `docs:` prefix does not trigger release-please workflow, which means changes won't be deployed. Always use `feat(docs):` to ensure documentation updates are released.

### Examples

```bash
# Correct - will trigger release
feat(docs): add new tutorial for authentication
feat(docs): update API reference documentation
feat(docs): rename integration section to agent skills

# Incorrect - will NOT trigger release
docs: add new tutorial for authentication
docs: update API reference documentation
```

## Documentation Structure

- Content lives in `content/docs/`
- Navigation is controlled by `meta.json` files in each directory
- Use `index.mdx` for section overview pages (title should be "Overview")

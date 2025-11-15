# Code Review Command

A comprehensive code review tool that analyzes commits and generates detailed reviews.

## Usage

```bash
/code-review [pr-id|commit-id|description]
```

## Parameters

- `pr-id`: GitHub PR number (e.g., `123`)
- `commit-id`: Single commit hash or range (e.g., `abc123` or `abc123..def456`)
- `description`: Natural language description of code range to review

## Examples

```bash
/code-review 123
/code-review abc123..def456
/code-review "review authentication changes in the last week"
```

## Workflow

The command follows this automated workflow:

1. **Parse Input**: Determine if input is PR ID, commit ID, or description
2. **Create Output Directory**: Create `codereviews/yyyymmdd` directory based on current date
3. **Generate Commit List**: Create `codereviews/yyyymmdd/commit-list.md` with checkboxes for each commit
4. **Review Each Commit**: For each commit, analyze:
   - New mocks and alternatives
   - Test coverage quality
   - Unnecessary try/catch blocks and over-engineering
   - Key interface changes
   - Timer and delay usage patterns
5. **Generate Reviews**: Create individual `codereviews/yyyymmdd/review-{commit}.md` files
6. **Update Commit List**: Replace checkboxes with links to review files
7. **Summary**: Generate overall review summary

## Review Criteria

Each commit is reviewed against the bad code smells defined in your project's bad-smell documentation (typically in `specs/bad-smell.md` or `spec/bad-smell.md`).

The review process checks for:
- Mock implementations and alternatives
- Test coverage and quality
- Error handling patterns
- Interface changes and API design
- Timer and delay usage
- Dynamic import patterns

## Output Structure

```
codereviews/
└── yyyymmdd/            # Date-based directory (e.g., 20251115)
    ├── commit-list.md   # Master checklist with links to reviews
    ├── review-abc123.md # Individual commit review
    ├── review-def456.md # Individual commit review
    └── ...              # One review per commit
```

## Implementation Notes

- Uses GitHub CLI for PR information when available
- Supports both single commits and commit ranges
- Automatically detects commit boundaries for natural language inputs
- Generates structured markdown output for easy navigation

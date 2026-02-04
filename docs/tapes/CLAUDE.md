# Tapes

This folder contains VHS tape files for generating VM0 CLI demo GIFs.

## Recording Principles

- **Prefer interactive mode**: When a command supports interactive prompts (e.g., `vm0 init`, `vm0 artifact init`), use interactive mode instead of flags. Press `Enter` to accept defaults rather than using `-n` or `--name` flags.
- **Use comments**: Add comment lines (e.g., `Type "# Step description"`) to explain what each step does.
- **Every command needs a subtitle**: Each command should be preceded by a `# comment` explaining what it does, helping viewers understand each step.
- **Allow sufficient pauses**: Add adequate `Sleep` durations between commands for readability, especially after long-running commands (8s+ after agent runs).
- **Reference sample**: See `welcome/welcome.tape` as the best example that follows all conventions.

## Timing Conventions

### Comments (# subtitles)

```tape
Enter
Type "# Step description"
Sleep 1s
Enter
Sleep 300ms
Type "command"
```

- Add empty line (`Enter`) before starting a new comment section
- `Sleep 1s` after typing comment to let viewers read it
- Single `Enter` after comment (no extra blank line)
- `Sleep 300ms` before typing the command
- **No empty line between comment and command**

### Commands

```tape
Type "vm0 init"
Sleep 1s
Enter
Sleep 2s
```

- `Sleep 1s` before `Enter` to let viewers see the full command
- `Sleep` after `Enter` to show command output (duration varies by command)

### Example Flow

```tape
Enter
Type "# Create a new agent"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 init"
Sleep 1s
Enter
Sleep 2s

Enter
Type "# Edit the workflow"
Sleep 1s
Enter
Sleep 300ms
Type "vim AGENTS.md"
Sleep 1s
Enter
Sleep 5s
```

## Creating New Tapes

Reference `template.tape` for base styling:

```tape
# Terminal settings
Set Shell bash
Set FontSize 22
Set FontFamily "Menlo"
Set Width 1200
Set Height 900
Set Padding 30
Set Theme "Dracula"
Set TypingSpeed 50ms
```

## Waiting for `vm0 run` to Complete

When running agents with `vm0 run`, use `Wait+Screen` to wait for completion:

```tape
Type "vm0 run my-agent 'do something'"
Enter
Wait+Screen@120s /Run completed successfully/
Sleep 8s
```

- **Use `Wait+Screen` not `Wait+Line`**: `Wait+Line` only checks the last line, but after "Run completed successfully" prints, the cursor moves to a new line with the prompt, so `Wait+Line` will timeout.
- Use the exact pattern `/Run completed successfully/` - do not use partial matches like `/Run completed/` which may trigger early
- Set a reasonable timeout (e.g., `@120s` for 2 minutes)
- Add a `Sleep` after the wait to let viewers see the result before the next command
- **Multiple runs**: If running multiple agents sequentially, clear the screen between runs with `Ctrl+l` so the second `Wait+Screen` doesn't immediately match the first agent's completion message still visible on screen

## Setup and Cleanup with record.sh

VHS doesn't support setup/cleanup hooks. For tapes that need environment preparation (e.g., pre-creating files, composing agents), create a `record.sh` script in the tape folder:

```bash
#!/bin/bash
set -e

cd "$(dirname "$0")"

# Setup (not recorded)
echo "Setting up..."
rm -f vm0.yaml AGENTS.md
vm0 init -n demo-agent

# Record
echo "Recording..."
~/Developer/vhs/vhs my-tape.tape

# Cleanup
echo "Cleaning up..."
rm -f vm0.yaml AGENTS.md

echo "Done!"
```

Run with `./record.sh` instead of calling `vhs` directly.

## Generate GIF

For simple tapes without setup/cleanup:
```bash
vhs <name>.tape
```

For tapes with setup/cleanup:
```bash
./record.sh
```

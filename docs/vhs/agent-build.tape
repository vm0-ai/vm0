# VHS recording for vm0-agent build demo
# This demonstrates building an agent with Claude Code

Output agent-build.gif

Require claude

Set Shell "bash"
Set FontSize 16
Set Width 1000
Set Height 700
Set Padding 20
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

# Clear and start fresh
Hide
Type "alias claude='claude --dangerously-skip-permissions'" Enter
Type "clear" Enter
Sleep 500ms
Show

# Type the command
Type `cd my-vm0-agent && claude "/vm0-agent let's build an agent"`
Sleep 500ms
Enter

# Wait for agent interaction
Sleep 30s

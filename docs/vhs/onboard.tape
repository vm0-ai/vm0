# VHS recording for vm0 onboard command
# This demonstrates the guided setup flow for new VM0 users

Output onboard.gif

Require vm0

Set Shell "bash"
Set FontSize 16
Set Width 1000
Set Height 700
Set Padding 20
Set TypingSpeed 40ms
Set Theme "Catppuccin Mocha"

# Clear and start fresh
Hide
Type "clear" Enter
Sleep 500ms
Show

# Type the command
Type "vm0 onboard"
Sleep 500ms
Enter

# Wait for project name prompt
Sleep 2s

# Step 3: Use default project name (just Enter)
Enter

# Wait for plugin installation prompt
Sleep 1s

# Step 4: Confirm plugin installation (just Enter)
Enter

# Show next step - cd into project and run claude
Sleep 4s
Type `cd my-vm0-agent && claude "/vm0-agent let's build an agent"`
Sleep 1s

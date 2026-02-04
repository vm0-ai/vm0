# VM0 Quickstart Demo
Output quickstart.gif

# Terminal settings
Set Shell bash
Set FontSize 22
Set FontFamily "Menlo"
Set Width 1200
Set Height 900
Set Padding 30
Set Theme "Dracula"
Set TypingSpeed 50ms

# Start demo
Sleep 500ms

Type "# 1. Initialize a new agent"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 init"
Sleep 1s
Enter
Sleep 2s

# Accept default name
Enter
Sleep 2s

Enter
Type "# 2. Edit AGENTS.md with natural language"
Sleep 1s
Enter
Sleep 300ms
Type "vim AGENTS.md"
Sleep 1s
Enter
Sleep 3s

# Delete all content and enter insert mode
Type "ggdGi"
Sleep 500ms

# Type the new content
Type "Fetch top 10 articles from HackerNews and show me the best one"
Sleep 500ms

# Exit insert mode and save
Escape
Sleep 300ms
Type ":wq"
Enter
Sleep 1s

Enter
Type "# 3. Upload to VM0 cloud"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 compose vm0.yaml"
Sleep 1s
Enter
Wait+Screen@60s /Compose created|Compose version exists/
Sleep 3s

Enter
Type "# 4. Run the agent"
Sleep 1s
Enter
Sleep 300ms
Type "vm0 run quickstart 'start working'"
Sleep 1s
Enter
Wait+Screen@120s /Run completed successfully/
Sleep 8s

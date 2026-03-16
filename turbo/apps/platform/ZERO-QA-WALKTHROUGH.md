# Zero App — QA Walkthrough

This document guides team members through six structured test flows to verify Zero's end-to-end functionality. Use the checklists to track progress as you test.

> **Environment**: Test on both light and dark mode. Verify UI contrast, hover states, and empty states throughout.

---

## Preconditions

- [ ] Signed in with a valid account
- [ ] At least one model provider configured (or ready to add one)
- [ ] Browser DevTools open to watch for console errors

---

## Flow 1: Chat Conversation

Test the core chat experience — sending messages, receiving responses, attachments, and session management.

### 1.1 Landing Page

- [ ] Navigate to `/zero` (or click **New chat** in the sidebar)
- [ ] Welcome tagline displays with typewriter animation (e.g., "Welcome back, {name}.")
- [ ] Agent avatar displays correctly
- [ ] Suggested prompts are visible below the welcome message

### 1.2 Sending a Message

- [ ] Type a message in the composer and press Enter (or click Send)
- [ ] Message appears in the conversation immediately
- [ ] Agent response streams in after a short delay
- [ ] Conversation scrolls to the latest message automatically

### 1.3 Model Selection

- [ ] Click the model selector dropdown in the composer bar
- [ ] Options display: **Default**, **Fast**, **Smart**
- [ ] Select a different model, send a message — verify it works
- [ ] Hover state on the dropdown is visible (especially in dark mode)

### 1.4 Attachments

- [ ] Click the paperclip icon in the composer bar
- [ ] File picker opens — select a supported file (image, PDF, txt, csv, md, json)
- [ ] Attachment preview appears in the composer area
- [ ] Send the message with attachment — verify it's included
- [ ] Remove an attachment before sending (click the X on the preview)

### 1.5 Connectors in Chat

- [ ] Click the plug icon in the composer bar to open connectors popover
- [ ] Connected services (Gmail, Notion, Slack, etc.) are listed
- [ ] "Add connector" and "Manage connectors" links are functional

### 1.6 Session Management

- [ ] After sending messages, click **New chat** in the sidebar
- [ ] Previous session appears in the **Recent** list in the sidebar
- [ ] Click a recent session — conversation loads correctly
- [ ] Search for a session in the sidebar search bar
- [ ] Verify session URL updates to `/zero/chat/:sessionId`

### Edge Cases

- [ ] Send an empty message — should be prevented
- [ ] Very long message — verify it wraps and displays correctly
- [ ] Rapid multiple sends — no duplicate messages or UI glitches

---

## Flow 2: Agent Configuration

Test the agent profile settings and model provider management.

### 2.1 Meet Page — Profile

- [ ] Navigate to `/zero/meet` (click agent avatar in sidebar or "Meet" nav item)
- [ ] **Profile tab**: verify agent display name, description, and tone are shown
- [ ] Edit the display name → Save → refresh the page → verify it persists
- [ ] Edit the description → Save → verify it persists
- [ ] Change the tone (e.g., Professional → Friendly) → Save → verify it persists
- [ ] Click **Discard** on the unsaved changes bar → verify changes revert

### 2.2 Meet Page — Other Tabs

- [ ] **Connectors tab**: connected and available connectors display correctly
- [ ] **Scheduled tab**: schedule entries list (or empty state with illustration)
- [ ] **Instructions tab**: custom instructions can be viewed and edited

### 2.3 Settings — Model Providers

- [ ] Navigate to `/zero/settings` via sidebar
- [ ] Default model provider selector displays current selection
- [ ] Change the default provider → verify it updates
- [ ] Click **Add provider** (dashed border card) → dialog opens
- [ ] Fill in provider details → Save → verify new provider appears in the list
- [ ] Click an existing provider card → **Edit** → modify settings → Save → verify changes
- [ ] Click an existing provider card → **Delete** → confirm → verify it's removed

### Edge Cases

- [ ] Save with empty required fields — should show validation
- [ ] Delete the last provider — verify appropriate behavior
- [ ] Dark mode: dashed borders on "Add provider" card should be visible

---

## Flow 3: Connectors — Add, Remove, Use in Chat

Test the full connector lifecycle: connect, verify in chat, disconnect.

### 3.1 Add a Connector

- [ ] Navigate to `/zero/meet` → **Connectors** tab
- [ ] Click **Add connector** to open the connection dialog
- [ ] Browse available connectors (Gmail, GitHub, Notion, Slack, etc.)
- [ ] Pick a connector that uses **OAuth** (e.g., Gmail or GitHub)
- [ ] Complete the OAuth authorization flow
- [ ] Verify the connector now shows as **Connected** with a checkmark
- [ ] Pick a connector that uses **API token** (e.g., OpenAI, Anthropic)
- [ ] Enter the API token → Submit → verify it connects

### 3.2 Use Connector in Chat

- [ ] Navigate back to `/zero` (chat)
- [ ] Open the connectors popover (plug icon)
- [ ] Verify the newly connected service appears in the list
- [ ] Send a message that exercises the connector (e.g., "Summarize my latest GitHub notifications")
- [ ] Verify the agent accesses the service and returns relevant data

### 3.3 Remove a Connector

- [ ] Navigate to `/zero/meet` → **Connectors** tab
- [ ] Find a connected connector and click the remove / disconnect action
- [ ] Verify it moves back to "Available" (no longer shows as connected)
- [ ] Return to chat → open connectors popover → verify removed service is gone
- [ ] Send a message referencing the disconnected service — verify graceful handling

### Edge Cases

- [ ] Cancel mid-way through OAuth — verify no broken state
- [ ] Invalid API token — verify error message displays
- [ ] Connect the same connector twice — should not create duplicates

---

## Flow 4: Create a Task with Schedule

Test schedule creation, editing, toggling, and deletion.

### 4.1 Create a Schedule via UI

- [ ] Navigate to `/zero/schedule` via sidebar
- [ ] Click the **Add** button to open the schedule dialog
- [ ] Enter a prompt: "Send me a daily summary of my inbox"
- [ ] Select time option: **Every weekday**
- [ ] Set hour and minute (e.g., 9:00 AM)
- [ ] Verify timezone displays correctly (matches your local timezone)
- [ ] Click **Save**
- [ ] Verify the entry appears in the list with correct time, prompt, and status

### 4.2 Manage Schedule Entries

- [ ] **Toggle** the schedule on/off — verify the switch state persists after refresh
- [ ] **Edit** the schedule entry — change the prompt or time → Save → verify changes
- [ ] Switch to **calendar view** — verify the entry appears on the correct day/time slots
- [ ] Switch back to **list view** — entries are still correct
- [ ] **Delete** the schedule entry → confirm → verify it's removed from both views

### 4.3 Create a Schedule via Chat

- [ ] Navigate to `/zero` (chat)
- [ ] Send: "Set a daily 9am schedule to summarize my emails"
- [ ] Verify Zero acknowledges the schedule creation
- [ ] Navigate to `/zero/schedule` — verify the new entry appears

### Edge Cases

- [ ] Create a "Once" schedule with a past date — verify behavior
- [ ] Create a "Loop" schedule (every N minutes) — verify it appears correctly
- [ ] Empty prompt — should show validation error
- [ ] Multiple schedules at the same time — verify no conflicts

---

## Flow 5: Create a Subagent and Chat

Test sub-agent creation, configuration, pinning, and chatting.

### 5.1 View the Team Page

- [ ] Navigate to `/zero/team` via sidebar
- [ ] Main agent card displays with correct name and avatar
- [ ] If no sub-agents exist, empty state message displays: "No teammates yet"
- [ ] "Start a chat to create a new teammate" prompt is visible

### 5.2 Create a Sub-agent via Chat

- [ ] Navigate to `/zero` (chat)
- [ ] Send: "Create a teammate called code-reviewer that reviews pull requests"
- [ ] Verify Zero acknowledges the creation
- [ ] Navigate to `/zero/team`
- [ ] Verify the new **code-reviewer** sub-agent card appears in the grid

### 5.3 Configure the Sub-agent

- [ ] Click the sub-agent card → detail page loads (`/zero/team/code-reviewer`)
- [ ] Verify all tabs are present: **Connectors**, **Scheduled**, **Profile**, **Instructions**
- [ ] **Profile tab**: edit display name, description, tone → Save → verify persistence
- [ ] **Connectors tab**: add a connector to the sub-agent → verify it appears
- [ ] **Scheduled tab**: add a schedule for the sub-agent → verify it appears
- [ ] **Instructions tab**: add custom instructions → Save → verify persistence

### 5.4 Chat with the Sub-agent

- [ ] On the sub-agent detail page, click **"Chat with code-reviewer"**
- [ ] Verify the chat opens with the sub-agent (name and avatar should reflect the sub-agent)
- [ ] Send a message — verify the sub-agent responds (not the main agent)
- [ ] Verify the session is associated with the sub-agent

### 5.5 Pin and Reorder Sub-agents

- [ ] In the sidebar, click the **+** button next to agent avatars
- [ ] **Manage pinned agents** dialog opens
- [ ] Default agent shows with "Default" label (cannot be unpinned)
- [ ] Click **Pin** on the sub-agent → it moves to the "Pinned" section
- [ ] Pin additional agents (up to the max of 4)
- [ ] **Drag** a pinned agent up or down to reorder → verify order changes
- [ ] Click **X** on a pinned agent to unpin → verify it moves back to "Available"
- [ ] Click **Save** to close the dialog
- [ ] Verify pinned agents appear as avatars in the sidebar
- [ ] Click a pinned sub-agent avatar in the sidebar → chat switches to that agent

### Edge Cases

- [ ] Try to pin more than 4 agents — Pin button should be disabled
- [ ] Delete a sub-agent that is pinned — verify it's removed from pinned list
- [ ] Dark mode: drag handle, X button, and Pin button hover states are visible

---

## Flow 6: Manage Preferences

Test the personal preferences page — appearance, notifications, and time zone.

### 6.1 Navigate to Preferences

- [ ] Click the account avatar at the bottom of the sidebar
- [ ] Select **Preferences** from the dropdown menu
- [ ] Preferences page loads at `/zero/preferences`
- [ ] Page title "Preferences" and description are displayed
- [ ] Three tabs are visible: **Appearance**, **Notifications**, **Time Zone**

### 6.2 Appearance

- [ ] **Appearance** tab is selected by default
- [ ] Three theme options display: **Light**, **Dark**, **System**
- [ ] Current selection is highlighted with a primary-colored border
- [ ] Click **Dark** — theme switches to dark mode immediately
- [ ] Click **Light** — theme switches to light mode immediately
- [ ] Click **System** — theme follows OS preference
- [ ] Refresh the page — selected theme persists

### 6.3 Notifications

- [ ] Switch to the **Notifications** tab
- [ ] Two notification channels display: **Email** and **Slack**
- [ ] Each has a toggle switch and description text
- [ ] Toggle **Email Notifications** on → verify the switch updates (loading spinner during save)
- [ ] Toggle **Email Notifications** off → verify it reverts
- [ ] Toggle **Slack Notifications** on → verify the switch updates
- [ ] Refresh the page — toggle states persist
- [ ] Icons render correctly (email icon inverts in dark mode)

### 6.4 Time Zone

- [ ] Switch to the **Time Zone** tab
- [ ] Current timezone displays in a dropdown selector
- [ ] Description explains: "Your agents will use this time zone during runs"
- [ ] Open the dropdown — common timezones are listed (UTC, ET, PT, CST, JST, etc.)
- [ ] Select a different timezone (e.g., **Pacific Time**)
- [ ] Loading spinner appears briefly during save
- [ ] Refresh the page — selected timezone persists
- [ ] Verify this timezone is reflected in schedule entries (Flow 4)

### Edge Cases

- [ ] Rapidly toggle notifications — no race conditions or flickering
- [ ] Dark mode: theme card borders, toggle tracks, and dropdown are all visible
- [ ] Skeleton loading states display while preferences are being fetched

---

## General Checks (All Flows)

- [ ] **Dark mode**: all pages render correctly with proper contrast
- [ ] **Responsive**: sidebar collapses, content adapts to narrow screens
- [ ] **Loading states**: spinners / skeletons display during data fetches
- [ ] **Error states**: network errors show meaningful messages (not blank screens)
- [ ] **Console**: no unexpected errors or warnings in browser DevTools
- [ ] **Navigation**: browser back/forward buttons work correctly between pages

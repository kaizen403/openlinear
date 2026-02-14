## Notepad initialized for brainstorm-feature plan

### Task 3: Wire questions phase into GlobalQuickCapture
- Phase model: `"ghost" | "input" | "questions" | "stream"` — questions sits between input and stream
- `MOCK_TASKS` array and all `setTimeout` simulation code deleted; `handleSubmit` now calls real API (`checkBrainstormAvailability` + `generateBrainstormQuestions`)
- `ToggleButton` component, `ToggleId` type, and `toggles` state were unused in the new flow — removed
- `handleBrainstorm` custom event handler also routes through questions phase (sets input, then auto-fetches questions after 100ms to let React flush `setQuery`)
- `GeneratedTask` interface and `TaskCard` component kept as-is for Task 5 (stream wiring)
- `answers` state is `Record<string, string>` keyed by question text — will need conversion to `{ question, answer }[]` array format in Task 5 for the streaming API
- Sidebar expands to 400px for both `"questions"` and `"stream"` phases

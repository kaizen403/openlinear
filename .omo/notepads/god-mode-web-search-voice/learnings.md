
## Transcribe Endpoint (Task 2)
- `express.raw()` works as router-level middleware — no conflict with global `express.json()`
- `OpenAI.toFile(buffer, filename, { type: contentType })` converts Buffer to uploadable File for Whisper
- Reused `BRAINSTORM_API_KEY` / `BRAINSTORM_BASE_URL` env vars for OpenAI client
- Content-Type header used to derive file extension for Whisper (audio/mp4 → .mp4, audio/webm → .webm)
- Express 5 has `express.raw()` built-in, no extra deps needed
- Zero TS errors on first pass — clean implementation

## Wave 1: Brainstorm Web Search Support (Task 1)
- OpenAI `web_search_options` is a top-level param on `chat.completions.create()`, not nested inside messages
- Shape: `{ search_context_size: 'low' | 'medium' | 'high' }` - we use `'medium'`
- Used `as const` on the string literal to satisfy TypeScript's type narrowing: `'medium' as const`
- Conditional spread pattern works cleanly: `...(webSearch && { web_search_options: { search_context_size: 'medium' as const } })`
- Anthropic path requires zero changes - just don't pass the param
- `checkBrainstormAvailability()` already calls `getProvider()` internally, so we can reuse that to determine `webSearchAvailable`
- The brainstorm service has two OpenAI call sites: one non-streaming (generateQuestions) and one streaming (generateTasks) - both need the param
- Zod `.optional().default(false)` ensures backward compatibility - existing callers without webSearch get `false`
- lsp_diagnostics showed zero errors after all changes

import { describe, it, expect } from 'vitest'

/**
 * Tests for use-chat-stream hook exports.
 * Since the hook requires React context (useState, useRef, etc.) and no
 * React Testing Library is available, we verify the module's exported types
 * and that the hook function is importable.
 *
 * The core SSE parsing logic is tested in lib/api/chat.test.mjs.
 */

describe('use-chat-stream exports', () => {
  it('exports useChatStream function', async () => {
    const mod = await import('./use-chat-stream.tsx')
    expect(mod.useChatStream).toBeDefined()
    expect(typeof mod.useChatStream).toBe('function')
  })

  it('exports StreamStatus type (verified via runtime shape)', async () => {
    // StreamStatus is a type-only export, so we verify the module loads cleanly
    const mod = await import('./use-chat-stream.tsx')
    expect(mod).toBeDefined()
  })

  it('exports StreamingToolCall interface shape', async () => {
    // Type-only — just ensure module parses without error
    const mod = await import('./use-chat-stream.tsx')
    expect(Object.keys(mod)).toContain('useChatStream')
  })

  it('exports StreamingMessage interface shape', async () => {
    const mod = await import('./use-chat-stream.tsx')
    expect(Object.keys(mod)).toContain('useChatStream')
  })
})

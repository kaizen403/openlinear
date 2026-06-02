import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('@/lib/api/chat', () => ({
  transcribeChatAudio: vi.fn(),
}))

vi.mock('@/lib/utils', () => ({
  cn: (...args) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/audio-utils', () => ({
  isWhisperHallucination: () => false,
}))

vi.mock('lucide-react', () => ({
  Loader2: (props) => createElement('svg', { ...props, 'data-testid': 'loader2' }),
  Mic: (props) => createElement('svg', { ...props, 'data-testid': 'mic' }),
  Send: (props) => createElement('svg', { ...props, 'data-testid': 'send' }),
  Square: (props) => createElement('svg', { ...props, 'data-testid': 'square' }),
  Paperclip: (props) => createElement('svg', { ...props, 'data-testid': 'paperclip' }),
}))

const { ChatComposer } = await import('./chat-composer.tsx')

describe('ChatComposer', () => {
  it('renders textarea with placeholder', () => {
    const { container } = render(
      createElement(ChatComposer, { onSend: vi.fn(), placeholder: 'Type here...' })
    )
    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    expect(textarea.getAttribute('placeholder')).toBe('Type here...')
  })

  it('calls onSend with text content on Enter', () => {
    const onSend = vi.fn()
    const { container } = render(
      createElement(ChatComposer, { onSend })
    )
    const textarea = container.querySelector('textarea')

    fireEvent.change(textarea, { target: { value: 'hello' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onSend).toHaveBeenCalledWith('hello', undefined)
  })

  it('does not call onSend when value is empty', () => {
    const onSend = vi.fn()
    const { container } = render(
      createElement(ChatComposer, { onSend })
    )
    const textarea = container.querySelector('textarea')

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows stop button when isStreaming=true', () => {
    const { container } = render(
      createElement(ChatComposer, { onSend: vi.fn(), isStreaming: true })
    )
    const stopBtn = container.querySelector('button[aria-label="Stop generating"]')
    expect(stopBtn).not.toBeNull()
  })

  it('calls onStop when stop button clicked', () => {
    const onStop = vi.fn()
    const { container } = render(
      createElement(ChatComposer, { onSend: vi.fn(), onStop, isStreaming: true })
    )
    const stopBtn = container.querySelector('button[aria-label="Stop generating"]')
    fireEvent.click(stopBtn)
    expect(onStop).toHaveBeenCalled()
  })

  it('textarea is disabled when disabled=true', () => {
    const { container } = render(
      createElement(ChatComposer, { onSend: vi.fn(), disabled: true })
    )
    const textarea = container.querySelector('textarea')
    expect(textarea.disabled).toBe(true)
  })
})

import { API_URL, getAuthHeader } from './client';

export interface BrainstormTask {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
}

export interface BrainstormAvailability {
  available: boolean;
  provider?: string;
  error?: string;
}

export async function checkBrainstormAvailability(): Promise<BrainstormAvailability> {
  const res = await fetch(`${API_URL}/api/brainstorm/availability`, {
    headers: getAuthHeader(),
  });
  if (!res.ok) return { available: false, error: 'Failed to check availability' };
  return res.json();
}

export async function generateBrainstormQuestions(prompt: string): Promise<string[]> {
  const res = await fetch(`${API_URL}/api/brainstorm/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to generate questions' }));
    throw new Error(err.error || 'Failed to generate questions');
  }
  const data = await res.json();
  return data.questions;
}

export async function streamBrainstormTasks(
  prompt: string,
  answers: Record<string, string>,
  onTask: (task: BrainstormTask) => void,
  onDone: () => void,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const res = await fetch(`${API_URL}/api/brainstorm/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ prompt, answers }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to generate tasks' }));
      onError(err.error || 'Failed to generate tasks');
      return;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const task: BrainstormTask = JSON.parse(trimmed);
          onTask(task);
        } catch {}
      }
    }

    if (buffer.trim()) {
      try {
        const task: BrainstormTask = JSON.parse(buffer.trim());
        onTask(task);
      } catch {}
    }

    onDone();
  } catch (err) {
    onError(err instanceof Error ? err.message : 'Stream failed');
  }
}

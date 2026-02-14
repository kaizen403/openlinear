import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export interface BrainstormTask {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
}

const QUESTIONS_SYSTEM_PROMPT =
  "You are a project planning assistant. Given the user's idea, generate 3-5 specific clarifying questions to better understand the scope, technical approach, priority, and constraints. Return ONLY a JSON array of question strings. No other text.";

const TASKS_SYSTEM_PROMPT =
  "You are a project planning assistant. Based on the user's idea and their answers to clarifying questions, generate 3-10 specific, actionable development tasks. Output each task as a JSON object on its own line (NDJSON format). Each object must have: title (string, concise action item), description (string, 1-2 sentences explaining why/what), priority (string, one of: low, medium, high). Output ONLY the JSON objects, one per line. No other text.";

function getProvider(): string {
  return process.env.BRAINSTORM_PROVIDER || 'openai';
}

function getModel(): string {
  const provider = getProvider();
  if (process.env.BRAINSTORM_MODEL) return process.env.BRAINSTORM_MODEL;
  return provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini';
}

function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.BRAINSTORM_API_KEY,
    ...(process.env.BRAINSTORM_BASE_URL && { baseURL: process.env.BRAINSTORM_BASE_URL }),
  });
}

function createAnthropicClient(): Anthropic {
  return new Anthropic({
    apiKey: process.env.BRAINSTORM_API_KEY,
    ...(process.env.BRAINSTORM_BASE_URL && { baseURL: process.env.BRAINSTORM_BASE_URL }),
  });
}

export function checkBrainstormAvailability(): {
  available: boolean;
  provider: string;
  error?: string;
} {
  if (!process.env.BRAINSTORM_API_KEY) {
    return { available: false, provider: '', error: 'BRAINSTORM_API_KEY not configured' };
  }
  return { available: true, provider: getProvider() };
}

export async function generateQuestions(prompt: string): Promise<string[]> {
  const provider = getProvider();
  const model = getModel();

  if (provider === 'anthropic') {
    const client = createAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: QUESTIONS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      }
    }

    return JSON.parse(text) as string[];
  }

  const client = createOpenAIClient();
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: QUESTIONS_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  const content = completion.choices[0]?.message?.content || '[]';
  return JSON.parse(content) as string[];
}

export async function* generateTasks(
  prompt: string,
  answers: { question: string; answer: string }[],
): AsyncGenerator<BrainstormTask> {
  const provider = getProvider();
  const model = getModel();

  const qaContext = answers
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');
  const userContent = `Idea: ${prompt}\n\nClarifying Q&A:\n${qaContext}`;

  let buffer = '';

  if (provider === 'anthropic') {
    const client = createAnthropicClient();
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: TASKS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        buffer += event.delta.text;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const task = tryParseTask(line);
          if (task) yield task;
        }
      }
    }
  } else {
    const client = createOpenAIClient();
    const completion = await client.chat.completions.create({
      model,
      stream: true,
      messages: [
        { role: 'system', content: TASKS_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    });

    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        buffer += delta;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const task = tryParseTask(line);
          if (task) yield task;
        }
      }
    }
  }

  if (buffer.trim()) {
    const task = tryParseTask(buffer);
    if (task) yield task;
  }
}

function tryParseTask(line: string): BrainstormTask | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (
      typeof parsed.title === 'string' &&
      typeof parsed.description === 'string' &&
      (parsed.priority === 'low' || parsed.priority === 'medium' || parsed.priority === 'high')
    ) {
      return {
        title: parsed.title,
        description: parsed.description,
        priority: parsed.priority,
      };
    }
  } catch {
    // Skip malformed JSON lines
  }

  return null;
}

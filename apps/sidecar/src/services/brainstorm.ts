import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { CodebaseContext } from './codebase-context';

export interface BrainstormTask {
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
}

export type BrainstormMode = 'basic' | 'pro';

function formatContextForPrompt(ctx: CodebaseContext): string {
  if (ctx.files.length === 0) return 'No codebase context available.';
  return ctx.files.map((f) => `--- ${f.path} ---\n${f.snippet}`).join('\n\n');
}

function buildBasicTasksPrompt(ctx: CodebaseContext, taskCount: number): string {
  return `You are a senior software engineer breaking down a development goal into actionable tasks.

<codebase_context>
${formatContextForPrompt(ctx)}
</codebase_context>

Based on the codebase context and user's goal, generate approximately ${taskCount} tasks. Use the task count as a granularity guide — fewer means higher-level, more means finer-grained subtasks. You may go slightly above or below.

Each task must reference specific files, functions, or patterns from the codebase when relevant. Output each task as a JSON object on its own line (NDJSON). Each object must have:
- title (string, concise action starting with a verb)
- description (string, 1-3 sentences explaining what to do and why, referencing specific files/functions)
- priority (string: "high", "medium", or "low")

Output ONLY JSON objects, one per line. No markdown, no commentary.`;
}

function buildProTasksPrompt(ctx: CodebaseContext, taskCount: number): string {
  return `You are a principal engineer creating a comprehensive development plan. You have deep knowledge of software architecture and can create thorough, well-ordered task breakdowns.

<codebase_context>
${formatContextForPrompt(ctx)}
</codebase_context>

Based on the codebase context, the user's goal, their answers to clarifying questions, and any web research context, generate approximately ${taskCount} tasks. Use the task count as a granularity guide.

Each task must:
- Reference specific files, functions, or modules from the codebase
- Include clear acceptance criteria in the description
- Be ordered logically (dependencies first)
- Consider edge cases, error handling, and testing

Output each task as a JSON object on its own line (NDJSON). Each object must have:
- title (string, concise action starting with a verb)
- description (string, 2-4 sentences with specific file references, acceptance criteria)
- priority (string: "high", "medium", or "low")

Output ONLY JSON objects, one per line. No markdown, no commentary.`;
}

function buildProQuestionsPrompt(ctx: CodebaseContext): string {
  return `You are a principal engineer helping to scope a development task. You have access to the project's codebase structure.

<codebase_context>
${formatContextForPrompt(ctx)}
</codebase_context>

Given the user's goal, generate 3-5 specific clarifying questions that reference actual files, patterns, or architectural decisions visible in the codebase. The questions should help determine scope, approach, and constraints. Return ONLY a JSON array of question strings. No other text.`;
}

function buildJsonQuestionsPrompt(ctx: CodebaseContext): string {
  return `${buildProQuestionsPrompt(ctx)}

For JSON-mode providers, return exactly one JSON object:
{"questions":["question 1","question 2","question 3"]}
No markdown. No explanation.`;
}

function buildJsonTasksPrompt(ctx: CodebaseContext, taskCount: number, mode: BrainstormMode): string {
  const base = mode === 'pro'
    ? buildProTasksPrompt(ctx, taskCount)
    : buildBasicTasksPrompt(ctx, taskCount);
  return `${base}

For JSON-mode providers, return exactly one JSON object:
{"tasks":[{"title":"...","description":"...","priority":"high|medium|low"}]}
No markdown. No explanation.`;
}

function getProvider(): string {
  return process.env.BRAINSTORM_PROVIDER || 'openai';
}

function getModel(mode: BrainstormMode): string {
  const provider = getProvider();
  if (mode === 'pro') {
    if (process.env.BRAINSTORM_PRO_MODEL) return process.env.BRAINSTORM_PRO_MODEL;
    return provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o';
  }
  if (process.env.BRAINSTORM_MODEL) return process.env.BRAINSTORM_MODEL;
  return provider === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o-mini';
}

function createOpenAIClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.BRAINSTORM_API_KEY,
    ...(process.env.BRAINSTORM_BASE_URL && { baseURL: process.env.BRAINSTORM_BASE_URL }),
  });
}

function supportsOpenAIJsonMode(): boolean {
  const provider = getProvider();
  const baseUrl = process.env.BRAINSTORM_BASE_URL?.toLowerCase() ?? '';
  return provider === 'openai' && (baseUrl.includes('fireworks.ai') || !baseUrl);
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
  webSearchAvailable: boolean;
  proAvailable: boolean;
  error?: string;
} {
  if (!process.env.BRAINSTORM_API_KEY) {
    return {
      available: false,
      provider: '',
      webSearchAvailable: false,
      proAvailable: false,
      error: 'BRAINSTORM_API_KEY not configured',
    };
  }
  const provider = getProvider();
  const proAvailable = Boolean(process.env.BRAINSTORM_PRO_MODEL || process.env.BRAINSTORM_API_KEY);
  const baseUrl = process.env.BRAINSTORM_BASE_URL?.toLowerCase() ?? '';
  return {
    available: true,
    provider,
    webSearchAvailable: provider === 'openai' && !baseUrl.includes('fireworks.ai'),
    proAvailable,
  };
}

export async function generateQuestions(
  prompt: string,
  webSearch: boolean,
  codebaseContext: CodebaseContext,
): Promise<string[]> {
  const provider = getProvider();
  const model = getModel('pro');
  const systemPrompt = supportsOpenAIJsonMode()
    ? buildJsonQuestionsPrompt(codebaseContext)
    : buildProQuestionsPrompt(codebaseContext);

  if (provider === 'anthropic') {
    const client = createAnthropicClient();
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
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
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    ...(supportsOpenAIJsonMode() ? { response_format: { type: 'json_object' as const } } : {}),
    ...(webSearch && { web_search_options: { search_context_size: 'medium' as const } }),
  });

  const content = completion.choices[0]?.message?.content || '[]';
  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
  if (isObject(parsed) && Array.isArray(parsed.questions)) {
    return parsed.questions.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

export async function* generateTasks(
  prompt: string,
  answers: { question: string; answer: string }[],
  webSearch: boolean,
  mode: BrainstormMode,
  taskCount: number,
  codebaseContext: CodebaseContext,
): AsyncGenerator<BrainstormTask> {
  const provider = getProvider();
  const model = getModel(mode);
  const systemPrompt = supportsOpenAIJsonMode()
    ? buildJsonTasksPrompt(codebaseContext, taskCount, mode)
    : mode === 'pro'
      ? buildProTasksPrompt(codebaseContext, taskCount)
      : buildBasicTasksPrompt(codebaseContext, taskCount);

  const qaContext = answers
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');
  const userContent = qaContext
    ? `Goal: ${prompt}\n\nClarifying Q&A:\n${qaContext}`
    : `Goal: ${prompt}`;

  let buffer = '';

  if (provider === 'anthropic') {
    const client = createAnthropicClient();
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt,
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
    if (supportsOpenAIJsonMode()) {
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      });
      const content = completion.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(content) as unknown;
      const tasks = isObject(parsed) && Array.isArray(parsed.tasks) ? parsed.tasks : [];
      for (const item of tasks) {
        const task = normalizeTask(item);
        if (task) yield task;
      }
      return;
    }

    const completion = await client.chat.completions.create({
      model,
      stream: true,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      ...(webSearch && { web_search_options: { search_context_size: 'medium' as const } }),
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
    return null;
  }

  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTask(value: unknown): BrainstormTask | null {
  if (!isObject(value)) return null;
  if (
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    (value.priority === 'low' || value.priority === 'medium' || value.priority === 'high')
  ) {
    return {
      title: value.title,
      description: value.description,
      priority: value.priority,
    };
  }
  return null;
}

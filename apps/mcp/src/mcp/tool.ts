import type {
  CallToolResult,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import type * as z from 'zod';
import type { PatPrincipal } from '../auth';
import type { OpenLinearApi } from '../openlinear/api';
import type { RequestScope } from './context';
import { describeFailure } from './errors';

/**
 * MCP tool annotations (spec `ToolAnnotations`). All four hints are always
 * set explicitly: clients assume `destructiveHint: true` and
 * `openWorldHint: true` when they are absent.
 */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Always false: every tool only touches the caller's own OpenLinear data. */
  openWorldHint: false;
}

export const READ_ONLY: ToolHints = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export interface ToolContext {
  api: OpenLinearApi;
  principal: PatPrincipal;
  /** Aborted when the MCP client cancels the call. */
  signal: AbortSignal;
  toolName: string;
}

export interface ToolDefinition<I extends z.ZodType, O extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: I;
  output: O;
  annotations: ToolHints;
  /**
   * Alternative PAT scope sets, each enough for every API route the tool calls
   * (apps/api/src/registry.ts, W02b families). `a + b` means both scopes.
   */
  scopes: readonly string[];
  run(args: z.output<I>, ctx: ToolContext): Promise<z.input<O>>;
}

/** A tool definition with its types erased, so tools can live in one list. */
export interface RegisteredToolSpec {
  name: string;
  title: string;
  annotations: ToolHints;
  scopes: readonly string[];
  register(server: McpServer, scope: RequestScope): void;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

async function execute<I extends z.ZodType, O extends z.ZodType>(
  definition: ToolDefinition<I, O>,
  scope: RequestScope,
  rawArgs: unknown,
  ctx: ServerContext,
): Promise<CallToolResult> {
  const context: ToolContext = {
    api: scope.api(),
    principal: scope.principal,
    signal: ctx.mcpReq.signal,
    toolName: definition.name,
  };
  try {
    // The SDK has already validated the arguments; parsing again only
    // recovers their static type (the schemas have no side effects).
    const args = definition.input.parse(rawArgs);
    // Parsing strips anything the output schema does not declare, so the
    // structured content always validates against the advertised schema.
    const structured = definition.output.parse(await definition.run(args, context));
    scope.logUsage(definition.name, true);
    return { content: [{ type: 'text', text: jsonText(structured) }], structuredContent: structured };
  } catch (error) {
    const failure = describeFailure(error, {
      tool: definition.name,
      scopes: definition.scopes,
      safeToRetry: definition.annotations.readOnlyHint || definition.annotations.idempotentHint,
    });
    if (failure.code === 'INTERNAL' || failure.code === 'UNEXPECTED_RESPONSE') {
      console.error(
        JSON.stringify({
          level: 'error',
          msg: 'tool failed',
          tool: definition.name,
          code: failure.code,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        }),
      );
    }
    scope.logUsage(definition.name, false, failure.code);
    return { content: [{ type: 'text', text: failure.message }], isError: true };
  }
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(definition: ToolDefinition<I, O>): RegisteredToolSpec {
  return {
    name: definition.name,
    title: definition.title,
    annotations: definition.annotations,
    scopes: definition.scopes,
    register(server, scope) {
      // Widened to the SDK's schema interface so the callback type is concrete.
      const inputSchema: StandardSchemaWithJSON = definition.input;
      const outputSchema: StandardSchemaWithJSON = definition.output;
      server.registerTool(
        definition.name,
        {
          title: definition.title,
          description: definition.description,
          inputSchema,
          outputSchema,
          annotations: { title: definition.title, ...definition.annotations },
        },
        (args: unknown, ctx: ServerContext) => execute(definition, scope, args, ctx),
      );
    },
  };
}

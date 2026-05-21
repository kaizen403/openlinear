import { OpenLinearApiError } from "../../openlinear/client";

export function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: typeof value === "object" && value !== null ? { ...(value as Record<string, unknown>) } : undefined,
  };
}

export function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: formatError(error),
      },
    ],
  };
}

export function formatError(error: unknown): string {
  if (error instanceof OpenLinearApiError) {
    if (error.status === 401) return "Authentication failed. Check the OpenLinear personal access token.";
    if (error.status === 403) return "Insufficient permissions for this OpenLinear operation.";
    if (error.status === 404) return "OpenLinear resource not found.";
    return `OpenLinear API ${error.status}: ${extractApiMessage(error.responseText)}`;
  }

  if (error instanceof Error) return error.message;
  return "Request failed";
}

function extractApiMessage(responseText: string): string {
  try {
    const body = JSON.parse(responseText) as { message?: string; error?: { message?: string } };
    return body.error?.message ?? body.message ?? responseText;
  } catch {
    return responseText;
  }
}

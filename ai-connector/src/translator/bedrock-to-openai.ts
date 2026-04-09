import type {
  ChatCompletionChunk,
  ChatCompletionDelta,
} from "../types/openai";

interface ChunkParams {
  id: string;
  model: string;
}

/**
 * Maps Bedrock stop reasons to OpenAI finish_reason values.
 */
export function mapStopReason(
  bedrockReason: string
): "stop" | "tool_calls" | "length" {
  switch (bedrockReason) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

/**
 * Creates the initial SSE chunk with role: assistant (sent on messageStart).
 */
export function createInitialChunk(params: ChunkParams): ChatCompletionChunk {
  return buildChunk({ role: "assistant" }, null, params);
}

/**
 * Translates a Bedrock contentBlockStart event to an OpenAI chunk.
 * Returns null for text blocks (no chunk needed until delta arrives).
 */
export function translateContentBlockStart(
  event: { contentBlockIndex: number; start: Record<string, unknown> },
  params: ChunkParams
): ChatCompletionChunk | null {
  if (event.start.toolUse) {
    const toolUse = event.start.toolUse as {
      toolUseId: string;
      name: string;
    };
    return buildChunk(
      {
        tool_calls: [
          {
            index: event.contentBlockIndex,
            id: toolUse.toolUseId,
            type: "function",
            function: { name: toolUse.name, arguments: "" },
          },
        ],
      },
      null,
      params
    );
  }

  // Text content block start — no chunk needed, wait for delta
  return null;
}

/**
 * Translates a Bedrock contentBlockDelta event to an OpenAI chunk.
 */
export function translateContentBlockDelta(
  event: { contentBlockIndex: number; delta: Record<string, unknown> },
  params: ChunkParams
): ChatCompletionChunk {
  if (event.delta.text !== undefined) {
    return buildChunk({ content: event.delta.text as string }, null, params);
  }

  if (event.delta.toolUse) {
    const toolUse = event.delta.toolUse as { input: string };
    return buildChunk(
      {
        tool_calls: [
          {
            index: event.contentBlockIndex,
            function: { arguments: toolUse.input },
          },
        ],
      },
      null,
      params
    );
  }

  // Unknown delta type — return empty delta
  return buildChunk({}, null, params);
}

/**
 * Translates a Bedrock messageStop event to an OpenAI chunk with finish_reason.
 */
export function translateMessageStop(
  stopReason: string,
  params: ChunkParams
): ChatCompletionChunk {
  return buildChunk({}, mapStopReason(stopReason), params);
}

export interface BedrockUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/**
 * Translates Bedrock metadata (usage) to an OpenAI chunk.
 * Cache token counts are passed through as extra fields for observability.
 */
export function translateMetadata(
  metadata: { usage?: BedrockUsage },
  params: ChunkParams
): ChatCompletionChunk {
  const chunk = buildChunk({}, null, params);
  if (metadata.usage) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage: any = {
      prompt_tokens: metadata.usage.inputTokens,
      completion_tokens: metadata.usage.outputTokens,
      total_tokens: metadata.usage.totalTokens,
    };
    if (metadata.usage.cacheReadInputTokens !== undefined) {
      usage.prompt_tokens_details = {
        cached_tokens: metadata.usage.cacheReadInputTokens,
      };
    }
    if (metadata.usage.cacheWriteInputTokens !== undefined) {
      usage.cache_write_input_tokens = metadata.usage.cacheWriteInputTokens;
    }
    chunk.usage = usage;
  }
  return chunk;
}

/**
 * Formats a ChatCompletionChunk as an SSE data line.
 * Pass null to emit the [DONE] sentinel.
 */
export function formatSSEChunk(chunk: ChatCompletionChunk | null): string {
  if (chunk === null) {
    return "data: [DONE]\n\n";
  }
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function buildChunk(
  delta: ChatCompletionDelta,
  finishReason: "stop" | "tool_calls" | "length" | null,
  params: ChunkParams
): ChatCompletionChunk {
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

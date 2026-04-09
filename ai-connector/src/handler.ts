import { validateAuth } from "./auth";
import { translateRequest } from "./translator/openai-to-bedrock";
import {
  createInitialChunk,
  translateContentBlockStart,
  translateContentBlockDelta,
  translateMessageStop,
  translateMetadata,
  formatSSEChunk,
  mapStopReason,
} from "./translator/bedrock-to-openai";
import type { BedrockUsage } from "./translator/bedrock-to-openai";
import { invokeBedrockStream } from "./bedrock-client";
import { getBedrockConfig } from "./config";
import { reportErrorToSlack } from "./slack";
import type { ChatCompletionRequest } from "./types/openai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamEvent = any;

export interface HandlerRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
  /** Optional DynamoDB config name from ?config= query param. Defaults to "default". */
  configName?: string;
}

export interface HandlerResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Writable sink for real-time SSE streaming (e.g. Lambda responseStream). */
export interface StreamWriter {
  write(data: string | Buffer): void;
}

/**
 * Result of prepareRequest — either an error to return immediately,
 * or a prepared Bedrock stream ready for piping / buffering.
 */
export type PrepareResult =
  | { ok: false; response: HandlerResponse }
  | { ok: true; stream: AsyncIterable<StreamEvent>; modelId: string; isStreaming: boolean };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  ...CORS_HEADERS,
};

/**
 * Phase 1: Validate auth, config, model, and invoke Bedrock.
 *
 * Returns either an error HandlerResponse or a prepared Bedrock stream
 * that the caller can pipe (real-time) or buffer (legacy).
 *
 * No response I/O happens here — the caller decides metadata/headers
 * based on the result, so error responses get proper status codes.
 */
export async function prepareRequest(
  req: HandlerRequest
): Promise<PrepareResult> {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return { ok: false, response: { statusCode: 200, headers: CORS_HEADERS } };
  }

  // Auth check (supports both static API key and Cognito JWT)
  const authResult = await validateAuth(req.headers.authorization);
  if (!authResult.ok) {
    return { ok: false, response: errorResponse(authResult.error.statusCode, authResult.error.message) };
  }

  // Method check
  if (req.method !== "POST") {
    return { ok: false, response: errorResponse(405, "Method not allowed") };
  }

  // Validate config name
  if (req.configName && !/^[a-zA-Z0-9_-]+$/.test(req.configName)) {
    return { ok: false, response: errorResponse(400, "Invalid config name") };
  }

  try {
    const openaiRequest: ChatCompletionRequest = JSON.parse(req.body);
    const config = await getBedrockConfig(req.configName);

    const modelId = resolveModelId(openaiRequest.model, config.modelId);
    openaiRequest.model = modelId;

    if (openaiRequest.temperature === undefined)
      openaiRequest.temperature = config.temperature;
    if (openaiRequest.max_tokens === undefined)
      openaiRequest.max_tokens = config.maxTokens;
    if (openaiRequest.top_p === undefined) openaiRequest.top_p = config.topP;

    const bedrockInput = translateRequest(openaiRequest, {
      promptCaching: config.promptCaching,
    });

    const stream = await invokeBedrockStream(bedrockInput);

    return {
      ok: true,
      stream,
      modelId,
      isStreaming: openaiRequest.stream !== false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    reportErrorToSlack({
      operation: "prepareRequest",
      error: message,
      configName: req.configName,
    }).catch(() => {});
    return { ok: false, response: errorResponse(500, message) };
  }
}

/**
 * Core request handler — validates, invokes Bedrock, and returns a
 * complete HandlerResponse with the full body (buffered).
 *
 * Used by tests and the non-streaming code path in index.ts.
 */
export async function handleRequest(
  req: HandlerRequest
): Promise<HandlerResponse> {
  const result = await prepareRequest(req);

  if (!result.ok) return result.response;

  if (result.isStreaming) {
    return handleStreamingBuffered(result.stream, result.modelId);
  }
  return handleNonStreaming(result.stream, result.modelId);
}

/**
 * Phase 2 (real-time): Pipe SSE chunks from the Bedrock stream directly
 * to a StreamWriter. Caller must have already set SSE response metadata.
 */
export async function pipeStreamToWriter(
  stream: AsyncIterable<StreamEvent>,
  model: string,
  writer: StreamWriter
): Promise<void> {
  const id = generateChunkId();
  const params = { id, model };

  try {
    for await (const event of stream) {
      if (event.messageStart) {
        writer.write(formatSSEChunk(createInitialChunk(params)));
      } else if (event.contentBlockStart) {
        const cbStart = event.contentBlockStart as {
          contentBlockIndex: number;
          start: Record<string, unknown>;
        };
        const chunk = translateContentBlockStart(cbStart, params);
        if (chunk) writer.write(formatSSEChunk(chunk));
      } else if (event.contentBlockDelta) {
        const cbDelta = event.contentBlockDelta as {
          contentBlockIndex: number;
          delta: Record<string, unknown>;
        };
        writer.write(formatSSEChunk(translateContentBlockDelta(cbDelta, params)));
      } else if (event.contentBlockStop) {
        // Bedrock signals end of a content block — no OpenAI equivalent needed
      } else if (event.messageStop) {
        const stop = event.messageStop as { stopReason: string };
        writer.write(formatSSEChunk(translateMessageStop(stop.stopReason, params)));
      } else if (event.metadata) {
        const meta = event.metadata as { usage?: BedrockUsage };
        writer.write(formatSSEChunk(translateMetadata(meta, params)));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream error";
    reportErrorToSlack({
      operation: "pipeStreamToWriter",
      error: message,
      model,
    }).catch(() => {});
    const errorChunk = {
      id: params.id,
      object: "chat.completion.chunk" as const,
      created: Math.floor(Date.now() / 1000),
      model: params.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop" as const,
        },
      ],
      error: { message, type: "server_error" },
    };
    writer.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
  }

  writer.write(formatSSEChunk(null)); // [DONE]
}

/**
 * Buffered streaming — collects all SSE chunks into a string body.
 * Used by handleRequest (test / legacy path).
 */
async function handleStreamingBuffered(
  stream: AsyncIterable<StreamEvent>,
  model: string
): Promise<HandlerResponse> {
  const id = generateChunkId();
  const params = { id, model };
  const chunks: string[] = [];

  try {
    for await (const event of stream) {
      if (event.messageStart) {
        chunks.push(formatSSEChunk(createInitialChunk(params)));
      } else if (event.contentBlockStart) {
        const cbStart = event.contentBlockStart as {
          contentBlockIndex: number;
          start: Record<string, unknown>;
        };
        const chunk = translateContentBlockStart(cbStart, params);
        if (chunk) chunks.push(formatSSEChunk(chunk));
      } else if (event.contentBlockDelta) {
        const cbDelta = event.contentBlockDelta as {
          contentBlockIndex: number;
          delta: Record<string, unknown>;
        };
        chunks.push(
          formatSSEChunk(translateContentBlockDelta(cbDelta, params))
        );
      } else if (event.contentBlockStop) {
        // Bedrock signals end of a content block — no OpenAI equivalent needed
      } else if (event.messageStop) {
        const stop = event.messageStop as { stopReason: string };
        chunks.push(
          formatSSEChunk(translateMessageStop(stop.stopReason, params))
        );
      } else if (event.metadata) {
        const meta = event.metadata as { usage?: BedrockUsage };
        chunks.push(formatSSEChunk(translateMetadata(meta, params)));
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream error";
    reportErrorToSlack({
      operation: "handleStreamingBuffered",
      error: message,
      model,
    }).catch(() => {});
    const errorChunk = {
      id: params.id,
      object: "chat.completion.chunk" as const,
      created: Math.floor(Date.now() / 1000),
      model: params.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop" as const,
        },
      ],
      error: { message, type: "server_error" },
    };
    chunks.push(`data: ${JSON.stringify(errorChunk)}\n\n`);
  }

  chunks.push(formatSSEChunk(null)); // [DONE]

  return {
    statusCode: 200,
    headers: SSE_HEADERS,
    body: chunks.join(""),
  };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

async function handleNonStreaming(
  stream: AsyncIterable<StreamEvent>,
  model: string
): Promise<HandlerResponse> {
  let content = "";
  let finishReason: "stop" | "tool_calls" | "length" = "stop";
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCalls: Map<number, ToolCallAccumulator> = new Map();

  for await (const event of stream) {
    if (event.contentBlockStart) {
      const cbStart = event.contentBlockStart as {
        contentBlockIndex: number;
        start: { toolUse?: { toolUseId: string; name: string } };
      };
      if (cbStart.start.toolUse) {
        toolCalls.set(cbStart.contentBlockIndex, {
          id: cbStart.start.toolUse.toolUseId,
          name: cbStart.start.toolUse.name,
          arguments: "",
        });
      }
    } else if (event.contentBlockDelta) {
      const cbDelta = event.contentBlockDelta as {
        contentBlockIndex: number;
        delta: { text?: string; toolUse?: { input: string } };
      };
      if (cbDelta.delta.text) {
        content += cbDelta.delta.text;
      }
      if (cbDelta.delta.toolUse) {
        const tc = toolCalls.get(cbDelta.contentBlockIndex);
        if (tc) {
          tc.arguments += cbDelta.delta.toolUse.input;
        }
      }
    } else if (event.messageStop) {
      const stop = event.messageStop as { stopReason: string };
      finishReason = mapStopReason(stop.stopReason);
    } else if (event.metadata) {
      const meta = event.metadata as { usage?: BedrockUsage };
      if (meta.usage) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const u: any = {
          prompt_tokens: meta.usage.inputTokens,
          completion_tokens: meta.usage.outputTokens,
          total_tokens: meta.usage.totalTokens,
        };
        if (meta.usage.cacheReadInputTokens !== undefined) {
          u.prompt_tokens_details = {
            cached_tokens: meta.usage.cacheReadInputTokens,
          };
        }
        if (meta.usage.cacheWriteInputTokens !== undefined) {
          u.cache_write_input_tokens = meta.usage.cacheWriteInputTokens;
        }
        usage = u;
      }
    }
  }

  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };

  if (toolCalls.size > 0) {
    message.tool_calls = Array.from(toolCalls.values()).map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  const response = {
    id: generateChunkId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage,
  };

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
    body: JSON.stringify(response),
  };
}

function resolveModelId(requestModel: string, defaultModelId: string): string {
  // If the model looks like a Bedrock model ID (contains a dot), use it directly
  if (requestModel.includes(".")) {
    return requestModel;
  }
  // Otherwise fall back to the config default
  return defaultModelId;
}

function generateChunkId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function errorResponse(
  statusCode: number,
  message: string
): HandlerResponse {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
    body: JSON.stringify({
      error: {
        message,
        type: statusCode >= 500 ? "server_error" : "invalid_request_error",
        code: statusCode.toString(),
      },
    }),
  };
}

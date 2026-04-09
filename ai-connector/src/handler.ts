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
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";

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
  | { ok: true; stream: AsyncIterable<ConverseStreamOutput>; modelId: string; isStreaming: boolean };

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

/** Max length for ?config= query param values. */
const CONFIG_NAME_MAX_LEN = 64;
const CONFIG_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Validates that the parsed body is a well-formed ChatCompletionRequest.
 * Returns a descriptive error string on failure, or null on success.
 */
function validateChatCompletionRequest(
  parsed: unknown
): string | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "Request body must be a JSON object";
  }
  const req = parsed as Record<string, unknown>;
  if (typeof req.model !== "string" || !req.model.trim()) {
    return "Missing or empty required field: model";
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    return "Missing or empty required field: messages";
  }
  return null;
}

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

  // Validate config name — must be alphanumeric/hyphen/underscore, max 64 chars
  if (req.configName !== undefined) {
    if (req.configName.length > CONFIG_NAME_MAX_LEN || !CONFIG_NAME_REGEX.test(req.configName)) {
      return { ok: false, response: errorResponse(400, "Invalid config name") };
    }
  }

  // Parse and validate request body — JSON errors are client errors (400)
  let openaiRequest: ChatCompletionRequest;
  try {
    const parsed: unknown = JSON.parse(req.body);
    const validationError = validateChatCompletionRequest(parsed);
    if (validationError) {
      return { ok: false, response: errorResponse(400, validationError) };
    }
    openaiRequest = parsed as ChatCompletionRequest;
  } catch {
    return { ok: false, response: errorResponse(400, "Invalid JSON in request body") };
  }

  try {
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

// ─── Shared SSE stream processor ────────────────────────────────────────────

/**
 * Drives both real-time streaming and buffered SSE paths.
 * Calls onChunk for each formatted SSE data line (including [DONE]).
 * Catches mid-stream errors and emits an error chunk before [DONE].
 */
async function processSSEStream(
  stream: AsyncIterable<ConverseStreamOutput>,
  params: { id: string; model: string },
  onChunk: (data: string) => void
): Promise<void> {
  try {
    for await (const event of stream) {
      if (event.messageStart) {
        onChunk(formatSSEChunk(createInitialChunk(params)));
      } else if (event.contentBlockStart) {
        const cbStart = {
          contentBlockIndex: event.contentBlockStart.contentBlockIndex ?? 0,
          start: (event.contentBlockStart.start ?? {}) as Record<string, unknown>,
        };
        const chunk = translateContentBlockStart(cbStart, params);
        if (chunk) onChunk(formatSSEChunk(chunk));
      } else if (event.contentBlockDelta) {
        const cbDelta = {
          contentBlockIndex: event.contentBlockDelta.contentBlockIndex ?? 0,
          delta: (event.contentBlockDelta.delta ?? {}) as Record<string, unknown>,
        };
        onChunk(formatSSEChunk(translateContentBlockDelta(cbDelta, params)));
      } else if (event.messageStop) {
        onChunk(formatSSEChunk(translateMessageStop(event.messageStop.stopReason ?? "", params)));
      } else if (event.metadata) {
        onChunk(formatSSEChunk(translateMetadata(
          event.metadata as { usage?: BedrockUsage },
          params
        )));
      }
      // contentBlockStop is intentionally skipped — no OpenAI equivalent
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Stream error";
    reportErrorToSlack({
      operation: "processSSEStream",
      error: message,
      model: params.model,
    }).catch(() => {});
    onChunk(buildMidStreamErrorChunk(message, params));
  }

  onChunk(formatSSEChunk(null)); // [DONE]
}

/**
 * Phase 2 (real-time): Pipe SSE chunks from the Bedrock stream directly
 * to a StreamWriter. Caller must have already set SSE response metadata.
 */
export async function pipeStreamToWriter(
  stream: AsyncIterable<ConverseStreamOutput>,
  model: string,
  writer: StreamWriter
): Promise<void> {
  const params = { id: generateChunkId(), model };
  await processSSEStream(stream, params, (chunk) => writer.write(chunk));
}

/**
 * Buffered streaming — collects all SSE chunks into a string body.
 * Used by handleRequest (test / legacy path).
 */
async function handleStreamingBuffered(
  stream: AsyncIterable<ConverseStreamOutput>,
  model: string
): Promise<HandlerResponse> {
  const params = { id: generateChunkId(), model };
  const chunks: string[] = [];
  await processSSEStream(stream, params, (chunk) => chunks.push(chunk));
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

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  cache_write_input_tokens?: number;
}

async function handleNonStreaming(
  stream: AsyncIterable<ConverseStreamOutput>,
  model: string
): Promise<HandlerResponse> {
  let content = "";
  let finishReason: "stop" | "tool_calls" | "length" = "stop";
  let usage: OpenAIUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const toolCalls: Map<number, ToolCallAccumulator> = new Map();

  for await (const event of stream) {
    if (event.contentBlockStart) {
      const toolUse = event.contentBlockStart.start?.toolUse;
      if (toolUse) {
        toolCalls.set(event.contentBlockStart.contentBlockIndex ?? 0, {
          id: toolUse.toolUseId ?? "",
          name: toolUse.name ?? "",
          arguments: "",
        });
      }
    } else if (event.contentBlockDelta) {
      const delta = event.contentBlockDelta.delta;
      if (delta && "text" in delta && typeof delta.text === "string") {
        content += delta.text;
      }
      if (delta && "toolUse" in delta && delta.toolUse) {
        const tc = toolCalls.get(event.contentBlockDelta.contentBlockIndex ?? 0);
        if (tc) {
          tc.arguments += (delta.toolUse as { input: string }).input ?? "";
        }
      }
    } else if (event.messageStop) {
      finishReason = mapStopReason(event.messageStop.stopReason ?? "");
    } else if (event.metadata) {
      const meta = event.metadata as { usage?: BedrockUsage };
      if (meta.usage) {
        usage = {
          prompt_tokens: meta.usage.inputTokens,
          completion_tokens: meta.usage.outputTokens,
          total_tokens: meta.usage.totalTokens,
        };
        if (meta.usage.cacheReadInputTokens !== undefined) {
          usage.prompt_tokens_details = {
            cached_tokens: meta.usage.cacheReadInputTokens,
          };
        }
        if (meta.usage.cacheWriteInputTokens !== undefined) {
          usage.cache_write_input_tokens = meta.usage.cacheWriteInputTokens;
        }
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

function buildMidStreamErrorChunk(
  message: string,
  params: { id: string; model: string }
): string {
  const chunk = {
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
    error: { message, type: "server_error", code: "500" },
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
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

import type {
  ChatCompletionRequest,
  ChatCompletionMessage,
  ChatCompletionTool,
} from "../types/openai";

/** Bedrock Converse API types (subset we need) */
interface BedrockConverseInput {
  modelId: string;
  messages: BedrockMessage[];
  system?: BedrockSystemContent[];
  inferenceConfig?: BedrockInferenceConfig;
  toolConfig?: BedrockToolConfig;
}

interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
}

type BedrockContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | {
      toolResult: {
        toolUseId: string;
        content: { text: string }[];
      };
    };

type BedrockSystemContent =
  | { text: string }
  | { cachePoint: { type: "default" } };

interface BedrockInferenceConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

type BedrockToolChoice =
  | { auto: Record<string, never> }
  | { any: Record<string, never> }
  | { tool: { name: string } };

type BedrockToolEntry = BedrockToolDef | { cachePoint: { type: "default" } };

interface BedrockToolConfig {
  tools: BedrockToolEntry[];
  toolChoice?: BedrockToolChoice;
}

interface BedrockToolDef {
  toolSpec: {
    name: string;
    description?: string;
    inputSchema: {
      json: Record<string, unknown>;
    };
  };
}

export type { BedrockConverseInput, BedrockMessage, BedrockContentBlock };

export interface TranslateOptions {
  /** When true, appends cachePoint blocks after system content and tool definitions. */
  promptCaching?: boolean;
}

/**
 * Translates an OpenAI ChatCompletion request into Bedrock Converse API input.
 */
export function translateRequest(
  request: ChatCompletionRequest,
  options: TranslateOptions = {}
): BedrockConverseInput {
  const system = extractSystemMessages(request.messages);
  const messages = translateMessages(request.messages);
  const inferenceConfig = buildInferenceConfig(request);
  const toolConfig = buildToolConfig(request.tools, request.tool_choice);

  const result: BedrockConverseInput = {
    modelId: request.model,
    messages,
  };

  if (system.length > 0) {
    if (options.promptCaching) {
      system.push({ cachePoint: { type: "default" } });
    }
    result.system = system;
  }
  if (inferenceConfig) {
    result.inferenceConfig = inferenceConfig;
  }
  if (toolConfig) {
    if (options.promptCaching && toolConfig.tools.length > 0) {
      toolConfig.tools.push({ cachePoint: { type: "default" } });
    }
    result.toolConfig = toolConfig;
  }

  return result;
}

function extractSystemMessages(
  messages: ChatCompletionMessage[]
): BedrockSystemContent[] {
  return messages
    .filter((m) => m.role === "system" && m.content)
    .map((m) => ({ text: m.content! }));
}

function translateMessages(
  messages: ChatCompletionMessage[]
): BedrockMessage[] {
  const nonSystem = messages.filter((m) => m.role !== "system");
  const translated: BedrockMessage[] = [];

  for (const msg of nonSystem) {
    const bedrockRole = msg.role === "tool" ? "user" : msg.role;
    const contentBlocks = translateMessageContent(msg);

    // Merge with previous message if same role (Bedrock requires alternation)
    const prev = translated[translated.length - 1];
    if (prev && prev.role === bedrockRole) {
      prev.content.push(...contentBlocks);
    } else {
      translated.push({
        role: bedrockRole as "user" | "assistant",
        content: contentBlocks,
      });
    }
  }

  return translated;
}

function translateMessageContent(
  msg: ChatCompletionMessage
): BedrockContentBlock[] {
  const blocks: BedrockContentBlock[] = [];

  // Tool result message
  if (msg.role === "tool") {
    blocks.push({
      toolResult: {
        toolUseId: msg.tool_call_id!,
        content: [{ text: msg.content || "" }],
      },
    });
    return blocks;
  }

  // Text content
  if (msg.content) {
    blocks.push({ text: msg.content });
  }

  // Tool calls from assistant
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: unknown;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        console.warn(
          `[ai-connector] Malformed tool arguments for "${tc.function.name}" — using empty object`
        );
        input = {};
      }
      blocks.push({
        toolUse: {
          toolUseId: tc.id,
          name: tc.function.name,
          input,
        },
      });
    }
  }

  return blocks;
}

function buildInferenceConfig(
  request: ChatCompletionRequest
): BedrockInferenceConfig | undefined {
  const config: BedrockInferenceConfig = {};
  let hasValue = false;

  if (request.temperature !== undefined) {
    config.temperature = request.temperature;
    hasValue = true;
  }
  if (request.max_tokens !== undefined) {
    config.maxTokens = request.max_tokens;
    hasValue = true;
  }
  if (request.top_p !== undefined) {
    config.topP = request.top_p;
    hasValue = true;
  }

  return hasValue ? config : undefined;
}

function buildToolConfig(
  tools?: ChatCompletionTool[],
  toolChoice?: ChatCompletionRequest["tool_choice"]
): BedrockToolConfig | undefined {
  if (!tools || tools.length === 0) return undefined;

  const config: BedrockToolConfig = {
    tools: tools.map((tool) => ({
      toolSpec: {
        name: tool.function.name,
        description: tool.function.description,
        inputSchema: {
          json: (tool.function.parameters as Record<string, unknown>) || {},
        },
      },
    })),
  };

  const choice = mapToolChoice(toolChoice);
  if (choice) {
    config.toolChoice = choice;
  }

  return config;
}

function mapToolChoice(
  toolChoice?: ChatCompletionRequest["tool_choice"]
): BedrockToolChoice | undefined {
  if (!toolChoice) return undefined;

  if (toolChoice === "auto") return { auto: {} };
  if (toolChoice === "required") return { any: {} };
  if (toolChoice === "none") return undefined;

  // Specific function: { type: "function", function: { name: "..." } }
  if (typeof toolChoice === "object" && toolChoice.function) {
    return { tool: { name: toolChoice.function.name } };
  }

  return undefined;
}

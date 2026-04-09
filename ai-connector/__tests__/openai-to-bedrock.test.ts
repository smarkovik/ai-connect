import { translateRequest } from "../src/translator/openai-to-bedrock";
import type { ChatCompletionRequest } from "../src/types/openai";

describe("translateRequest", () => {
  describe("system messages", () => {
    it("extracts system messages to the top-level system parameter", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
        ],
      };

      const result = translateRequest(request);

      expect(result.system).toEqual([{ text: "You are a helpful assistant." }]);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
    });

    it("concatenates multiple system messages", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "system", content: "Respond in French." },
          { role: "user", content: "Hello" },
        ],
      };

      const result = translateRequest(request);

      expect(result.system).toEqual([
        { text: "You are helpful." },
        { text: "Respond in French." },
      ]);
    });

    it("omits system parameter when no system messages exist", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = translateRequest(request);

      expect(result.system).toBeUndefined();
    });
  });

  describe("basic message translation", () => {
    it("translates a simple user message", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = translateRequest(request);

      expect(result.modelId).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
      expect(result.messages).toEqual([
        { role: "user", content: [{ text: "Hello" }] },
      ]);
    });

    it("translates a user-assistant-user conversation", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello! How can I help?" },
          { role: "user", content: "What is 2+2?" },
        ],
      };

      const result = translateRequest(request);

      expect(result.messages).toEqual([
        { role: "user", content: [{ text: "Hi" }] },
        { role: "assistant", content: [{ text: "Hello! How can I help?" }] },
        { role: "user", content: [{ text: "What is 2+2?" }] },
      ]);
    });
  });

  describe("consecutive same-role message merging", () => {
    it("merges consecutive user messages", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "user", content: "Hello" },
          { role: "user", content: "Are you there?" },
        ],
      };

      const result = translateRequest(request);

      expect(result.messages).toEqual([
        {
          role: "user",
          content: [{ text: "Hello" }, { text: "Are you there?" }],
        },
      ]);
    });
  });

  describe("tool calls (assistant -> tool use)", () => {
    it("translates assistant tool_calls to Bedrock toolUse blocks", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "user", content: "What's the weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris"}',
                },
              },
            ],
          },
        ],
      };

      const result = translateRequest(request);

      expect(result.messages[1]).toEqual({
        role: "assistant",
        content: [
          {
            toolUse: {
              toolUseId: "call_123",
              name: "get_weather",
              input: { city: "Paris" },
            },
          },
        ],
      });
    });

    it("includes text content alongside tool_calls when present", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "user", content: "What's the weather?" },
          {
            role: "assistant",
            content: "Let me check that for you.",
            tool_calls: [
              {
                id: "call_456",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris"}',
                },
              },
            ],
          },
        ],
      };

      const result = translateRequest(request);

      expect(result.messages[1]).toEqual({
        role: "assistant",
        content: [
          { text: "Let me check that for you." },
          {
            toolUse: {
              toolUseId: "call_456",
              name: "get_weather",
              input: { city: "Paris" },
            },
          },
        ],
      });
    });
  });

  describe("tool results", () => {
    it("translates tool role messages to user messages with toolResult", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "user", content: "Weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_789",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_789",
            content: '{"temp":22,"condition":"sunny"}',
          },
        ],
      };

      const result = translateRequest(request);

      expect(result.messages[2]).toEqual({
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: "call_789",
              content: [{ text: '{"temp":22,"condition":"sunny"}' }],
            },
          },
        ],
      });
    });

    it("merges consecutive tool results into one user message", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "user", content: "Weather in Paris and London?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"Paris"}',
                },
              },
              {
                id: "call_2",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"London"}',
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: '{"temp":22}',
          },
          {
            role: "tool",
            tool_call_id: "call_2",
            content: '{"temp":15}',
          },
        ],
      };

      const result = translateRequest(request);

      // Tool results (role "tool") become "user" role, so consecutive ones merge
      expect(result.messages[2]).toEqual({
        role: "user",
        content: [
          {
            toolResult: {
              toolUseId: "call_1",
              content: [{ text: '{"temp":22}' }],
            },
          },
          {
            toolResult: {
              toolUseId: "call_2",
              content: [{ text: '{"temp":15}' }],
            },
          },
        ],
      });
    });
  });

  describe("tool definitions", () => {
    it("translates OpenAI tools to Bedrock toolConfig", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather",
              parameters: {
                type: "object",
                properties: {
                  city: { type: "string", description: "City name" },
                },
                required: ["city"],
              },
            },
          },
        ],
      };

      const result = translateRequest(request);

      expect(result.toolConfig).toEqual({
        tools: [
          {
            toolSpec: {
              name: "get_weather",
              description: "Get current weather",
              inputSchema: {
                json: {
                  type: "object",
                  properties: {
                    city: { type: "string", description: "City name" },
                  },
                  required: ["city"],
                },
              },
            },
          },
        ],
      });
    });

    it("omits toolConfig when no tools defined", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = translateRequest(request);

      expect(result.toolConfig).toBeUndefined();
    });

    it("maps tool_choice 'auto' to Bedrock toolChoice auto", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: { name: "fn", parameters: {} },
          },
        ],
        tool_choice: "auto",
      };

      const result = translateRequest(request);

      expect(result.toolConfig!.toolChoice).toEqual({ auto: {} });
    });

    it("maps tool_choice 'required' to Bedrock toolChoice any", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: { name: "fn", parameters: {} },
          },
        ],
        tool_choice: "required",
      };

      const result = translateRequest(request);

      expect(result.toolConfig!.toolChoice).toEqual({ any: {} });
    });

    it("maps tool_choice with specific function to Bedrock toolChoice tool", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: { name: "get_weather", parameters: {} },
          },
        ],
        tool_choice: { type: "function", function: { name: "get_weather" } },
      };

      const result = translateRequest(request);

      expect(result.toolConfig!.toolChoice).toEqual({
        tool: { name: "get_weather" },
      });
    });

    it("does not set toolChoice when tool_choice is 'none'", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: { name: "fn", parameters: {} },
          },
        ],
        tool_choice: "none",
      };

      const result = translateRequest(request);

      expect(result.toolConfig!.toolChoice).toBeUndefined();
    });
  });

  describe("inference config", () => {
    it("maps temperature, max_tokens, and top_p to inferenceConfig", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.7,
        max_tokens: 500,
        top_p: 0.9,
      };

      const result = translateRequest(request);

      expect(result.inferenceConfig).toEqual({
        temperature: 0.7,
        maxTokens: 500,
        topP: 0.9,
      });
    });

    it("omits inferenceConfig when no parameters provided", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = translateRequest(request);

      expect(result.inferenceConfig).toBeUndefined();
    });

    it("includes only provided parameters in inferenceConfig", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.5,
      };

      const result = translateRequest(request);

      expect(result.inferenceConfig).toEqual({ temperature: 0.5 });
    });
  });

  describe("edge cases", () => {
    it("falls back to empty object when tool arguments are malformed JSON", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "fn", arguments: "not valid json{{{" },
              },
            ],
          },
        ],
      };

      const result = translateRequest(request);

      expect(result.messages[1].content).toEqual([
        { toolUse: { toolUseId: "call_bad", name: "fn", input: {} } },
      ]);
    });

    it("handles messages with null content", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "fn", arguments: "{}" },
              },
            ],
          },
        ],
      };

      const result = translateRequest(request);

      // Assistant with null content but tool_calls should only have toolUse blocks
      expect(result.messages[1].content).toEqual([
        { toolUse: { toolUseId: "call_1", name: "fn", input: {} } },
      ]);
    });
  });

  describe("prompt caching", () => {
    it("does not add cachePoint blocks when promptCaching is off", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "fn", parameters: {} },
          },
        ],
      };

      const result = translateRequest(request, { promptCaching: false });

      expect(result.system).toEqual([{ text: "You are helpful." }]);
      expect(result.toolConfig!.tools).toHaveLength(1);
    });

    it("appends cachePoint after system messages when promptCaching is on", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
      };

      const result = translateRequest(request, { promptCaching: true });

      expect(result.system).toEqual([
        { text: "You are helpful." },
        { text: "Be concise." },
        { cachePoint: { type: "default" } },
      ]);
    });

    it("appends cachePoint after tool definitions when promptCaching is on", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      };

      const result = translateRequest(request, { promptCaching: true });

      expect(result.toolConfig!.tools).toHaveLength(2);
      expect(result.toolConfig!.tools[1]).toEqual({
        cachePoint: { type: "default" },
      });
    });

    it("adds cachePoint to both system and tools when both present", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
        tools: [
          {
            type: "function",
            function: { name: "fn", parameters: {} },
          },
        ],
      };

      const result = translateRequest(request, { promptCaching: true });

      expect(result.system![result.system!.length - 1]).toEqual({
        cachePoint: { type: "default" },
      });
      expect(
        result.toolConfig!.tools[result.toolConfig!.tools.length - 1]
      ).toEqual({ cachePoint: { type: "default" } });
    });

    it("does not add cachePoint when there are no system messages", () => {
      const request: ChatCompletionRequest = {
        model: "anthropic.claude-sonnet-4-20250514-v1:0",
        messages: [{ role: "user", content: "Hello" }],
      };

      const result = translateRequest(request, { promptCaching: true });

      expect(result.system).toBeUndefined();
    });
  });
});

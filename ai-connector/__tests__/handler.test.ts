import { mockClient } from "aws-sdk-client-mock";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { handleRequest } from "../src/handler";

const bedrockMock = mockClient(BedrockRuntimeClient);

// Helper to create mock streams with correct typing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockStream(events: Record<string, unknown>[]): any {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

beforeEach(() => {
  bedrockMock.reset();
  process.env.AI_CONNECTOR_API_KEY = "test-key";
  process.env.AI_CONNECTOR_BEDROCK_REGION = "us-east-1";
  process.env.AI_CONNECTOR_BEDROCK_MODEL = "anthropic.claude-sonnet-4-20250514-v1:0";
});

afterEach(() => {
  delete process.env.AI_CONNECTOR_API_KEY;
  delete process.env.AI_CONNECTOR_BEDROCK_REGION;
  delete process.env.AI_CONNECTOR_BEDROCK_MODEL;
});

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/chat/completions",
    headers: { authorization: "Bearer test-key" },
    body: JSON.stringify({
      model: "anthropic.claude-sonnet-4-20250514-v1:0",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      ...overrides,
    }),
  };
}

describe("handleRequest", () => {
  describe("authentication", () => {
    it("returns 401 for missing auth header", async () => {
      const result = await handleRequest({
        method: "POST",
        path: "/chat/completions",
        headers: {},
        body: "{}",
      });

      expect(result.statusCode).toBe(401);
      const body = JSON.parse(result.body!);
      expect(body.error.message).toBe("Missing Authorization header");
    });

    it("returns 403 for invalid token", async () => {
      const result = await handleRequest({
        method: "POST",
        path: "/chat/completions",
        headers: { authorization: "Bearer wrong-key" },
        body: "{}",
      });

      expect(result.statusCode).toBe(403);
    });
  });

  describe("method validation", () => {
    it("returns 405 for GET requests", async () => {
      const result = await handleRequest({
        method: "GET",
        path: "/chat/completions",
        headers: { authorization: "Bearer test-key" },
        body: "",
      });

      expect(result.statusCode).toBe(405);
    });

    it("returns 200 for OPTIONS (CORS preflight)", async () => {
      const result = await handleRequest({
        method: "OPTIONS",
        path: "/chat/completions",
        headers: {},
        body: "",
      });

      expect(result.statusCode).toBe(200);
      expect(result.headers?.["Access-Control-Allow-Origin"]).toBe("*");
    });
  });

  describe("input validation", () => {
    it("returns 400 for invalid JSON body", async () => {
      const result = await handleRequest({
        method: "POST",
        path: "/chat/completions",
        headers: { authorization: "Bearer test-key" },
        body: "not json{",
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.error.message).toContain("Invalid JSON");
    });

    it("returns 400 when model field is missing", async () => {
      const result = await handleRequest({
        method: "POST",
        path: "/chat/completions",
        headers: { authorization: "Bearer test-key" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }),
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.error.message).toContain("model");
    });

    it("returns 400 when messages array is missing", async () => {
      const result = await handleRequest({
        method: "POST",
        path: "/chat/completions",
        headers: { authorization: "Bearer test-key" },
        body: JSON.stringify({ model: "anthropic.claude-sonnet-4-20250514-v1:0" }),
      });

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.error.message).toContain("messages");
    });

    it("returns 400 when messages array is empty", async () => {
      const result = await handleRequest({
        method: "POST",
        path: "/chat/completions",
        headers: { authorization: "Bearer test-key" },
        body: JSON.stringify({
          model: "anthropic.claude-sonnet-4-20250514-v1:0",
          messages: [],
        }),
      });

      expect(result.statusCode).toBe(400);
    });
  });

  describe("streaming response", () => {
    it("calls Bedrock and returns SSE chunks", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi there!" } } },
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } },
        ]),
      });

      const req = makeRequest();
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(200);
      expect(result.headers?.["Content-Type"]).toBe("text/event-stream");

      // Parse SSE chunks from body
      const lines = result
        .body!.split("\n\n")
        .filter((l) => l.startsWith("data: "));

      // Should have: initial chunk, text delta, stop, usage, [DONE]
      expect(lines.length).toBeGreaterThanOrEqual(4);

      // First chunk should have role: assistant
      const first = JSON.parse(lines[0].replace("data: ", ""));
      expect(first.choices[0].delta.role).toBe("assistant");

      // Second chunk should have text content
      const second = JSON.parse(lines[1].replace("data: ", ""));
      expect(second.choices[0].delta.content).toBe("Hi there!");

      // Third chunk should have finish_reason
      const third = JSON.parse(lines[2].replace("data: ", ""));
      expect(third.choices[0].finish_reason).toBe("stop");

      // Last line should be [DONE]
      const lastData = result.body!.trim().split("\n\n").pop();
      expect(lastData).toBe("data: [DONE]");
    });
  });

  describe("non-streaming response", () => {
    it("collects full response into a ChatCompletion object", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello " } } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "world!" } } },
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } } },
        ]),
      });

      const req = makeRequest({ stream: false });
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(200);
      expect(result.headers?.["Content-Type"]).toBe("application/json");

      const body = JSON.parse(result.body!);
      expect(body.object).toBe("chat.completion");
      expect(body.choices[0].message.role).toBe("assistant");
      expect(body.choices[0].message.content).toBe("Hello world!");
      expect(body.choices[0].finish_reason).toBe("stop");
      expect(body.usage.prompt_tokens).toBe(8);
      expect(body.usage.completion_tokens).toBe(3);
    });
  });

  describe("non-streaming tool calls", () => {
    it("collects tool_calls into the response message", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          {
            contentBlockStart: {
              contentBlockIndex: 0,
              start: { toolUse: { toolUseId: "call_abc", name: "get_weather" } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { toolUse: { input: '{"city":"Paris"}' } },
            },
          },
          { contentBlockStop: { contentBlockIndex: 0 } },
          { messageStop: { stopReason: "tool_use" } },
          { metadata: { usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } },
        ]),
      });

      const req = makeRequest({ stream: false });
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body!);
      expect(body.choices[0].finish_reason).toBe("tool_calls");
      expect(body.choices[0].message.tool_calls).toEqual([
        {
          id: "call_abc",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ]);
    });

    it("collects text alongside tool_calls", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          {
            contentBlockDelta: {
              contentBlockIndex: 0,
              delta: { text: "Let me check." },
            },
          },
          { contentBlockStop: { contentBlockIndex: 0 } },
          {
            contentBlockStart: {
              contentBlockIndex: 1,
              start: { toolUse: { toolUseId: "call_xyz", name: "lookup" } },
            },
          },
          {
            contentBlockDelta: {
              contentBlockIndex: 1,
              delta: { toolUse: { input: '{}' } },
            },
          },
          { contentBlockStop: { contentBlockIndex: 1 } },
          { messageStop: { stopReason: "tool_use" } },
          { metadata: { usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 } } },
        ]),
      });

      const req = makeRequest({ stream: false });
      const result = await handleRequest(req);

      const body = JSON.parse(result.body!);
      expect(body.choices[0].message.content).toBe("Let me check.");
      expect(body.choices[0].message.tool_calls).toHaveLength(1);
      expect(body.choices[0].message.tool_calls[0].function.name).toBe("lookup");
    });
  });

  describe("streaming contentBlockStop handling", () => {
    it("handles contentBlockStop events without errors", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hi" } } },
          { contentBlockStop: { contentBlockIndex: 0 } },
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } },
        ]),
      });

      const req = makeRequest();
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(200);
      const lines = result.body!.split("\n\n").filter((l) => l.startsWith("data: "));
      // Should have: initial, text delta, stop, usage, [DONE] — contentBlockStop is skipped
      expect(lines.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("model fallback", () => {
    it("uses AI_CONNECTOR_BEDROCK_MODEL env var when request model is generic", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
        ]),
      });

      const req = makeRequest({ model: "custom-llm" });
      await handleRequest(req);

      const calls = bedrockMock.commandCalls(ConverseStreamCommand);
      expect(calls[0].args[0].input.modelId).toBe(
        "anthropic.claude-sonnet-4-20250514-v1:0"
      );
    });
  });

  describe("error handling", () => {
    it("returns 500 with OpenAI-format error when Bedrock fails", async () => {
      bedrockMock
        .on(ConverseStreamCommand)
        .rejects(new Error("Bedrock is down"));

      const req = makeRequest();
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body!);
      expect(body.error.type).toBe("server_error");
      expect(body.error.message).toContain("Bedrock is down");
    });
  });

  describe("config name validation", () => {
    it("accepts valid config names with alphanumeric, hyphens, underscores", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
        ]),
      });

      const req = {
        ...makeRequest(),
        configName: "voice-prod_v2",
      };
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(200);
    });

    it("rejects config names with invalid characters", async () => {
      const req = {
        ...makeRequest(),
        configName: "../../etc/passwd",
      };
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.error.message).toBe("Invalid config name");
    });

    it("rejects config names with spaces", async () => {
      const req = {
        ...makeRequest(),
        configName: "my config",
      };
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(400);
    });

    it("rejects config names longer than 64 characters", async () => {
      const req = {
        ...makeRequest(),
        configName: "a".repeat(65),
      };
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body!);
      expect(body.error.message).toBe("Invalid config name");
    });

    it("accepts config names of exactly 64 characters", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
        ]),
      });

      const req = {
        ...makeRequest(),
        configName: "a".repeat(64),
      };
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(200);
    });

    it("allows undefined configName (uses default)", async () => {
      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: mockStream([
          { messageStart: { role: "assistant" } },
          { messageStop: { stopReason: "end_turn" } },
          { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } },
        ]),
      });

      const req = makeRequest();
      const result = await handleRequest(req);

      expect(result.statusCode).toBe(200);
    });
  });

  describe("mid-stream error handling", () => {
    it("emits an SSE error chunk when Bedrock fails mid-stream", async () => {
      // Create a stream that yields one event then throws
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const failingStream: any = (async function* () {
        yield { messageStart: { role: "assistant" } };
        yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } };
        throw new Error("Connection reset");
      })();

      bedrockMock.on(ConverseStreamCommand).resolves({
        stream: failingStream,
      });

      const req = makeRequest();
      const result = await handleRequest(req);

      // Should still return 200 (SSE stream already started)
      expect(result.statusCode).toBe(200);
      expect(result.headers?.["Content-Type"]).toBe("text/event-stream");

      // Body should contain partial content + error chunk + [DONE]
      const lines = result.body!.split("\n\n").filter((l) => l.startsWith("data: "));

      // Should end with [DONE]
      expect(result.body!.trim().endsWith("data: [DONE]")).toBe(true);

      // Should contain an error chunk with code field
      const hasError = lines.some((line) => {
        if (line === "data: [DONE]") return false;
        const parsed = JSON.parse(line.replace("data: ", ""));
        return (
          parsed.error?.message === "Connection reset" &&
          parsed.error?.code === "500"
        );
      });
      expect(hasError).toBe(true);
    });
  });
});

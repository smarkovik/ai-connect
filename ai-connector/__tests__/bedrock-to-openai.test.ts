import {
  createInitialChunk,
  translateContentBlockStart,
  translateContentBlockDelta,
  translateMessageStop,
  translateMetadata,
  formatSSEChunk,
  mapStopReason,
} from "../src/translator/bedrock-to-openai";

const BASE_PARAMS = { id: "chatcmpl-test123", model: "anthropic.claude-sonnet-4-20250514-v1:0" };

describe("mapStopReason", () => {
  it("maps end_turn to stop", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
  });

  it("maps tool_use to tool_calls", () => {
    expect(mapStopReason("tool_use")).toBe("tool_calls");
  });

  it("maps max_tokens to length", () => {
    expect(mapStopReason("max_tokens")).toBe("length");
  });

  it("returns stop for unknown reasons", () => {
    expect(mapStopReason("something_else")).toBe("stop");
  });
});

describe("createInitialChunk", () => {
  it("creates a chunk with role: assistant and no content", () => {
    const chunk = createInitialChunk(BASE_PARAMS);

    expect(chunk.id).toBe("chatcmpl-test123");
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.model).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
    expect(chunk.choices).toHaveLength(1);
    expect(chunk.choices[0].index).toBe(0);
    expect(chunk.choices[0].delta).toEqual({ role: "assistant" });
    expect(chunk.choices[0].finish_reason).toBeNull();
  });

  it("sets created to a Unix timestamp", () => {
    const chunk = createInitialChunk(BASE_PARAMS);
    expect(typeof chunk.created).toBe("number");
    expect(chunk.created).toBeGreaterThan(1700000000);
  });
});

describe("translateContentBlockStart", () => {
  it("returns null for text content blocks", () => {
    const event = { contentBlockIndex: 0, start: { text: "" } };
    const result = translateContentBlockStart(event, BASE_PARAMS);
    expect(result).toBeNull();
  });

  it("creates a tool_calls delta for toolUse content blocks", () => {
    const event = {
      contentBlockIndex: 1,
      start: { toolUse: { toolUseId: "call_abc", name: "get_weather" } },
    };

    const chunk = translateContentBlockStart(event, BASE_PARAMS);

    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].delta.tool_calls).toEqual([
      {
        index: 1,
        id: "call_abc",
        type: "function",
        function: { name: "get_weather", arguments: "" },
      },
    ]);
  });
});

describe("translateContentBlockDelta", () => {
  it("creates a content delta for text deltas", () => {
    const event = {
      contentBlockIndex: 0,
      delta: { text: "Hello world" },
    };

    const chunk = translateContentBlockDelta(event, BASE_PARAMS);

    expect(chunk.choices[0].delta.content).toBe("Hello world");
    expect(chunk.choices[0].delta.tool_calls).toBeUndefined();
  });

  it("creates a tool_calls delta for toolUse input deltas", () => {
    const event = {
      contentBlockIndex: 1,
      delta: { toolUse: { input: '{"city":' } },
    };

    const chunk = translateContentBlockDelta(event, BASE_PARAMS);

    expect(chunk.choices[0].delta.tool_calls).toEqual([
      { index: 1, function: { arguments: '{"city":' } },
    ]);
    expect(chunk.choices[0].delta.content).toBeUndefined();
  });
});

describe("translateMessageStop", () => {
  it("creates a chunk with the mapped finish_reason", () => {
    const chunk = translateMessageStop("end_turn", BASE_PARAMS);

    expect(chunk.choices[0].finish_reason).toBe("stop");
    expect(chunk.choices[0].delta).toEqual({});
  });

  it("maps tool_use stop reason correctly", () => {
    const chunk = translateMessageStop("tool_use", BASE_PARAMS);

    expect(chunk.choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("translateMetadata", () => {
  it("creates a chunk with usage data", () => {
    const metadata = {
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };

    const chunk = translateMetadata(metadata, BASE_PARAMS);

    expect(chunk.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  it("includes prompt_tokens_details.cached_tokens when cache read tokens present", () => {
    const metadata = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadInputTokens: 80,
      },
    };

    const chunk = translateMetadata(metadata, BASE_PARAMS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = chunk.usage as any;
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 80 });
  });

  it("includes cache_write_input_tokens when cache write tokens present", () => {
    const metadata = {
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheWriteInputTokens: 100,
      },
    };

    const chunk = translateMetadata(metadata, BASE_PARAMS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = chunk.usage as any;
    expect(usage.cache_write_input_tokens).toBe(100);
  });

  it("includes both cache fields when both present", () => {
    const metadata = {
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        cacheReadInputTokens: 150,
        cacheWriteInputTokens: 50,
      },
    };

    const chunk = translateMetadata(metadata, BASE_PARAMS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = chunk.usage as any;
    expect(usage.prompt_tokens_details).toEqual({ cached_tokens: 150 });
    expect(usage.cache_write_input_tokens).toBe(50);
    expect(usage.prompt_tokens).toBe(200);
  });

  it("omits cache fields when no cache tokens in usage", () => {
    const metadata = {
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };

    const chunk = translateMetadata(metadata, BASE_PARAMS);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = chunk.usage as any;
    expect(usage.prompt_tokens_details).toBeUndefined();
    expect(usage.cache_write_input_tokens).toBeUndefined();
  });
});

describe("formatSSEChunk", () => {
  it("formats a chunk as an SSE data line", () => {
    const chunk = createInitialChunk(BASE_PARAMS);
    const sse = formatSSEChunk(chunk);

    expect(sse).toMatch(/^data: \{.*\}\n\n$/);
    const parsed = JSON.parse(sse.replace("data: ", "").trim());
    expect(parsed.id).toBe("chatcmpl-test123");
  });

  it("formats the DONE sentinel", () => {
    const sse = formatSSEChunk(null);
    expect(sse).toBe("data: [DONE]\n\n");
  });
});

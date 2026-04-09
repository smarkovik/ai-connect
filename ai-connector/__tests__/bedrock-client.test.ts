import { mockClient } from "aws-sdk-client-mock";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { invokeBedrockStream } from "../src/bedrock-client";

const bedrockMock = mockClient(BedrockRuntimeClient);

describe("invokeBedrockStream", () => {
  beforeEach(() => {
    bedrockMock.reset();
    process.env.AI_CONNECTOR_BEDROCK_REGION = "us-east-1";
  });

  afterEach(() => {
    delete process.env.AI_CONNECTOR_BEDROCK_REGION;
  });

  it("sends a ConverseStreamCommand with the provided input", async () => {
    const mockStream = (async function* () {
      yield { contentBlockDelta: { delta: { text: "Hello" }, contentBlockIndex: 0 } };
    })();

    bedrockMock.on(ConverseStreamCommand).resolves({ stream: mockStream });

    const input = {
      modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
      messages: [{ role: "user" as const, content: [{ text: "Hi" }] }],
    };

    const stream = await invokeBedrockStream(input);
    expect(stream).toBeDefined();

    // Verify the command was called
    const calls = bedrockMock.commandCalls(ConverseStreamCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.modelId).toBe(
      "anthropic.claude-sonnet-4-20250514-v1:0"
    );
  });

  it("throws when stream is undefined in response", async () => {
    bedrockMock.on(ConverseStreamCommand).resolves({ stream: undefined });

    const input = {
      modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
      messages: [{ role: "user" as const, content: [{ text: "Hi" }] }],
    };

    await expect(invokeBedrockStream(input)).rejects.toThrow(
      "Bedrock returned no stream"
    );
  });
});

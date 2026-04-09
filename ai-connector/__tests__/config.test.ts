import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  getBedrockConfig,
  clearConfigCache,
  DEFAULT_BEDROCK_CONFIG,
} from "../src/config";

const dynamoMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  dynamoMock.reset();
  clearConfigCache();
  // Clear all env vars
  delete process.env.BEDROCK_REGION;
  delete process.env.BEDROCK_MODEL;
  delete process.env.ENV_NAME;
  delete process.env.DEFAULT_REGION;
  delete process.env.PROMPT_CACHING_ENABLED;
});

afterEach(() => {
  delete process.env.BEDROCK_REGION;
  delete process.env.BEDROCK_MODEL;
  delete process.env.ENV_NAME;
  delete process.env.DEFAULT_REGION;
  delete process.env.PROMPT_CACHING_ENABLED;
});

describe("DEFAULT_BEDROCK_CONFIG", () => {
  it("has sensible hardcoded defaults", () => {
    expect(DEFAULT_BEDROCK_CONFIG).toEqual({
      region: "us-east-1",
      modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
      temperature: 0.7,
      maxTokens: 1024,
      topP: 1.0,
      promptCaching: false,
    });
  });
});

describe("getBedrockConfig", () => {
  describe("with no overrides", () => {
    it("returns hardcoded defaults when no env vars or DynamoDB", async () => {
      // No ENV_NAME = no DynamoDB table lookup
      const config = await getBedrockConfig();

      expect(config.region).toBe("us-east-1");
      expect(config.modelId).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
      expect(config.temperature).toBe(0.7);
      expect(config.maxTokens).toBe(1024);
      expect(config.topP).toBe(1.0);
      expect(config.promptCaching).toBe(false);
    });
  });

  describe("env var overrides", () => {
    it("overrides region and model from env vars", async () => {
      process.env.BEDROCK_REGION = "eu-west-1";
      process.env.BEDROCK_MODEL = "anthropic.claude-haiku-4-5-20251001-v1:0";

      const config = await getBedrockConfig();

      expect(config.region).toBe("eu-west-1");
      expect(config.modelId).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
      // Other values remain defaults
      expect(config.temperature).toBe(0.7);
      expect(config.maxTokens).toBe(1024);
    });

    it("enables promptCaching via PROMPT_CACHING_ENABLED=true", async () => {
      process.env.PROMPT_CACHING_ENABLED = "true";

      const config = await getBedrockConfig();

      expect(config.promptCaching).toBe(true);
    });

    it("keeps promptCaching off when PROMPT_CACHING_ENABLED=false", async () => {
      process.env.PROMPT_CACHING_ENABLED = "false";

      const config = await getBedrockConfig();

      expect(config.promptCaching).toBe(false);
    });
  });

  describe("DynamoDB runtime overrides", () => {
    it("overrides all values from DynamoDB", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand).resolves({
        Item: {
          configId: "default",
          region: "ap-southeast-1",
          modelId: "meta.llama3-70b-instruct-v1:0",
          temperature: 0.3,
          maxTokens: 2048,
          topP: 0.9,
        },
      });

      const config = await getBedrockConfig();

      expect(config.region).toBe("ap-southeast-1");
      expect(config.modelId).toBe("meta.llama3-70b-instruct-v1:0");
      expect(config.temperature).toBe(0.3);
      expect(config.maxTokens).toBe(2048);
      expect(config.topP).toBe(0.9);
    });

    it("DynamoDB overrides take priority over env vars", async () => {
      process.env.ENV_NAME = "dev";
      process.env.BEDROCK_MODEL = "from-env-var";

      dynamoMock.on(GetCommand).resolves({
        Item: {
          configId: "default",
          modelId: "from-dynamodb",
        },
      });

      const config = await getBedrockConfig();

      expect(config.modelId).toBe("from-dynamodb");
    });

    it("DynamoDB can override promptCaching", async () => {
      process.env.ENV_NAME = "dev";
      process.env.PROMPT_CACHING_ENABLED = "true";

      dynamoMock.on(GetCommand).resolves({
        Item: {
          configId: "default",
          promptCaching: false,
        },
      });

      const config = await getBedrockConfig();

      expect(config.promptCaching).toBe(false);
    });

    it("partially overrides — missing DynamoDB fields keep env/default values", async () => {
      process.env.ENV_NAME = "dev";
      process.env.BEDROCK_REGION = "eu-west-1";

      dynamoMock.on(GetCommand).resolves({
        Item: {
          configId: "default",
          temperature: 0.5,
        },
      });

      const config = await getBedrockConfig();

      // region from env var (DynamoDB didn't override)
      expect(config.region).toBe("eu-west-1");
      // temperature from DynamoDB
      expect(config.temperature).toBe(0.5);
      // modelId from hardcoded default
      expect(config.modelId).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
    });

    it("falls back silently when DynamoDB item doesn't exist", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand).resolves({ Item: undefined });

      const config = await getBedrockConfig();

      // All defaults
      expect(config.region).toBe("us-east-1");
      expect(config.modelId).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
    });

    it("falls back silently when DynamoDB call fails", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand).rejects(new Error("Table not found"));

      const config = await getBedrockConfig();

      // All defaults
      expect(config.temperature).toBe(0.7);
    });
  });

  describe("caching", () => {
    it("caches the result and does not re-query DynamoDB on second call", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand).resolves({
        Item: { configId: "default", temperature: 0.2 },
      });

      const first = await getBedrockConfig();
      const second = await getBedrockConfig();

      expect(first.temperature).toBe(0.2);
      expect(second.temperature).toBe(0.2);
      // DynamoDB should only be called once
      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(1);
    });

    it("re-queries after cache is cleared", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand).resolves({
        Item: { configId: "default", temperature: 0.2 },
      });

      await getBedrockConfig();
      clearConfigCache();

      dynamoMock.on(GetCommand).resolves({
        Item: { configId: "default", temperature: 0.9 },
      });

      const config = await getBedrockConfig();

      expect(config.temperature).toBe(0.9);
      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(2);
    });

    it("caches named configs independently from default", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "default" } })
        .resolves({ Item: { configId: "default", temperature: 0.7 } });
      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "voice-prod" } })
        .resolves({ Item: { configId: "voice-prod", temperature: 0.3 } });

      const defaultConfig = await getBedrockConfig();
      const namedConfig = await getBedrockConfig("voice-prod");

      expect(defaultConfig.temperature).toBe(0.7);
      expect(namedConfig.temperature).toBe(0.3);

      // Second call to each should use cache
      await getBedrockConfig();
      await getBedrockConfig("voice-prod");
      // 2 calls: one for "default", one for "default" + "voice-prod"
      expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(3);
    });
  });

  describe("named configs", () => {
    it("loads a named config that overrides the default", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "default" } })
        .resolves({
          Item: { configId: "default", temperature: 0.7, maxTokens: 1024 },
        });
      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "voice-prod" } })
        .resolves({
          Item: { configId: "voice-prod", temperature: 0.3, maxTokens: 2048 },
        });

      const config = await getBedrockConfig("voice-prod");

      expect(config.temperature).toBe(0.3);
      expect(config.maxTokens).toBe(2048);
      // region/modelId come from defaults since named config doesn't set them
      expect(config.region).toBe("us-east-1");
    });

    it("named config partially overrides — inherits from default for missing fields", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "default" } })
        .resolves({
          Item: { configId: "default", modelId: "anthropic.claude-haiku-4-5-20251001-v1:0", temperature: 0.5 },
        });
      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "chat" } })
        .resolves({
          Item: { configId: "chat", temperature: 0.9 },
        });

      const config = await getBedrockConfig("chat");

      // temperature from named config
      expect(config.temperature).toBe(0.9);
      // modelId from default DynamoDB config
      expect(config.modelId).toBe("anthropic.claude-haiku-4-5-20251001-v1:0");
      // maxTokens from hardcoded defaults
      expect(config.maxTokens).toBe(1024);
    });

    it("falls back to default when named config does not exist in DynamoDB", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "default" } })
        .resolves({
          Item: { configId: "default", temperature: 0.5 },
        });
      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "nonexistent" } })
        .resolves({ Item: undefined });

      const config = await getBedrockConfig("nonexistent");

      // Gets the default config values
      expect(config.temperature).toBe(0.5);
    });

    it("treats undefined configName same as 'default'", async () => {
      process.env.ENV_NAME = "dev";

      dynamoMock.on(GetCommand).resolves({
        Item: { configId: "default", temperature: 0.4 },
      });

      const withUndefined = await getBedrockConfig(undefined);
      clearConfigCache();
      const withDefault = await getBedrockConfig("default");

      expect(withUndefined.temperature).toBe(0.4);
      expect(withDefault.temperature).toBe(0.4);
    });

    it("named config can override promptCaching from default", async () => {
      process.env.ENV_NAME = "dev";
      process.env.PROMPT_CACHING_ENABLED = "true";

      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "default" } })
        .resolves({ Item: undefined });
      dynamoMock.on(GetCommand, { TableName: "cali-dev-ai-connector-config", Key: { configId: "dev" } })
        .resolves({
          Item: { configId: "dev", promptCaching: false },
        });

      const config = await getBedrockConfig("dev");

      expect(config.promptCaching).toBe(false);
    });
  });
});

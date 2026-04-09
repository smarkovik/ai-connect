import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

/**
 * Bedrock LLM configuration for the AI Connector proxy.
 *
 * Resolution order (highest priority first):
 *   1. Per-request `model` field (if it looks like a Bedrock model ID)
 *   2. DynamoDB runtime config (table: cali-{ENV_NAME}-ai-connector-config, key: "default")
 *   3. Environment variables (BEDROCK_MODEL, BEDROCK_REGION)
 *   4. Hardcoded defaults below
 */
export interface BedrockConfig {
  /** AWS region for Bedrock API calls */
  region: string;
  /** Default Bedrock model ID */
  modelId: string;
  /** Sampling temperature (0-1). Lower = more deterministic. */
  temperature: number;
  /** Maximum tokens to generate in the response */
  maxTokens: number;
  /** Top-p (nucleus) sampling. 1.0 = no filtering. */
  topP: number;
  /** Enable Bedrock prompt caching (cachePoint blocks in system/tools). */
  promptCaching: boolean;
}

/**
 * Hardcoded defaults — the baseline when nothing else overrides.
 */
export const DEFAULT_BEDROCK_CONFIG: Readonly<BedrockConfig> = {
  region: "us-east-1",
  modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
  temperature: 0.7,
  maxTokens: 1024,
  topP: 1.0,
  promptCaching: false,
};

// ────────────────────────────────────────────────────────────────────────────────
// In-memory cache with TTL (keyed by config name)
// ────────────────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const configCache = new Map<string, { config: BedrockConfig; cachedAt: number }>();

/**
 * Returns the resolved BedrockConfig by merging (in priority order):
 *   hardcoded defaults → env vars → DynamoDB runtime overrides.
 *
 * @param configName - DynamoDB config key to load (defaults to "default").
 *   Pass a named config (e.g. "voice-prod", "chat") via ?config= query param.
 *   Named configs are merged on top of the "default" config — any field not set
 *   in the named config inherits from "default" (which itself inherits from
 *   env vars and hardcoded defaults).
 *
 * The result is cached for 5 minutes per config name.
 */
export async function getBedrockConfig(
  configName?: string
): Promise<BedrockConfig> {
  const key = configName || "default";
  const now = Date.now();
  const cached = configCache.get(key);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.config;
  }

  // Layer 1: Start with hardcoded defaults
  const config: BedrockConfig = { ...DEFAULT_BEDROCK_CONFIG };

  // Layer 2: Override with env vars (deploy-time)
  if (process.env.BEDROCK_REGION) config.region = process.env.BEDROCK_REGION;
  if (process.env.BEDROCK_MODEL) config.modelId = process.env.BEDROCK_MODEL;
  if (process.env.PROMPT_CACHING_ENABLED !== undefined)
    config.promptCaching = process.env.PROMPT_CACHING_ENABLED === "true";

  // Layer 3: Override with DynamoDB "default" config
  const defaultOverrides = await loadDynamoConfig("default");
  applyOverrides(config, defaultOverrides);

  // Layer 4: Override with DynamoDB named config (if different from "default")
  if (key !== "default") {
    const namedOverrides = await loadDynamoConfig(key);
    applyOverrides(config, namedOverrides);
  }

  configCache.set(key, { config, cachedAt: now });
  return config;
}

function applyOverrides(
  config: BedrockConfig,
  overrides: Partial<BedrockConfig> | null
): void {
  if (!overrides) return;
  if (overrides.region) config.region = overrides.region;
  if (overrides.modelId) config.modelId = overrides.modelId;
  if (overrides.temperature !== undefined)
    config.temperature = overrides.temperature;
  if (overrides.maxTokens !== undefined)
    config.maxTokens = overrides.maxTokens;
  if (overrides.topP !== undefined) config.topP = overrides.topP;
  if (overrides.promptCaching !== undefined)
    config.promptCaching = overrides.promptCaching;
}

/** Clears the config cache (useful after a DynamoDB update or in tests). */
export function clearConfigCache(): void {
  configCache.clear();
}

// ────────────────────────────────────────────────────────────────────────────────
// DynamoDB runtime config loader
// ────────────────────────────────────────────────────────────────────────────────
let docClient: DynamoDBDocumentClient | null = null;

function getDocClient(): DynamoDBDocumentClient {
  if (!docClient) {
    const client = new DynamoDBClient({
      region: process.env.DEFAULT_REGION || "eu-central-1",
    });
    docClient = DynamoDBDocumentClient.from(client);
  }
  return docClient;
}

function getTableName(): string | undefined {
  const env = process.env.ENV_NAME;
  if (!env) return undefined;
  return `cali-${env}-ai-connector-config`;
}

/**
 * Loads runtime config overrides from DynamoDB.
 * Returns null if the table is not configured or the item doesn't exist.
 */
async function loadDynamoConfig(
  configId: string
): Promise<Partial<BedrockConfig> | null> {
  const tableName = getTableName();
  if (!tableName) return null;

  try {
    const result = await getDocClient().send(
      new GetCommand({
        TableName: tableName,
        Key: { configId },
      })
    );

    if (!result.Item) return null;

    return {
      region: result.Item.region,
      modelId: result.Item.modelId,
      temperature: result.Item.temperature,
      maxTokens: result.Item.maxTokens,
      topP: result.Item.topP,
      promptCaching: result.Item.promptCaching,
    };
  } catch {
    // DynamoDB table may not exist yet — fall back silently
    return null;
  }
}

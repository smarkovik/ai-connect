# AI Connector: OpenAI-Compatible Bedrock Proxy

A lightweight Lambda proxy that translates OpenAI-format `/chat/completions` requests into AWS Bedrock ConverseStream API calls, returning SSE streaming responses.

## Architecture

```
Client   --POST /chat/completions (OpenAI format, stream:true)-->  Lambda Function URL
  Lambda  --ConverseStreamCommand-->  AWS Bedrock
  Lambda  <--stream events--  Bedrock
  Lambda  --SSE chunks (OpenAI format)-->  Client
```

**Why Lambda Function URL instead of API Gateway**: API Gateway REST does not support SSE streaming responses. Lambda Function URLs with `invoke_mode = "RESPONSE_STREAM"` and `awslambda.streamifyResponse` enable true chunked SSE, which is critical for voice time-to-first-token.

## Configuration

The AI Connector uses a **layered configuration system** (highest priority wins):

```
Layer 4:  Per-request params          ← model, temperature, etc. in the request body
Layer 3b: DynamoDB named config       ← ?config=voice-prod (cached 5 min per name)
Layer 3a: DynamoDB "default" config   ← shared baseline, change anytime
Layer 2:  Environment variables       ← set at deploy time via Terraform
Layer 1:  Hardcoded defaults          ← fallback baseline in TypeScript
```

### Layer 1: Hardcoded Defaults

Defined in `src/config.ts` as `DEFAULT_BEDROCK_CONFIG`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `region` | `us-east-1` | AWS region for Bedrock API calls |
| `modelId` | `anthropic.claude-sonnet-4-20250514-v1:0` | Bedrock model identifier |
| `temperature` | `0.7` | Sampling temperature (0-1). Lower = more deterministic |
| `maxTokens` | `1024` | Maximum tokens to generate per response |
| `topP` | `1.0` | Nucleus sampling. 1.0 = no filtering |
| `promptCaching` | `false` | Enable Bedrock prompt caching (see below) |

These are the baseline. They apply when nothing else overrides them.

### Layer 2: Environment Variables (Deploy-Time)

Set in Terraform (`infrastructure/ai-connector-lambda.tf`) and applied when the Lambda starts:

| Variable | Overrides | Example |
|----------|-----------|---------|
| `BEDROCK_REGION` | `region` | `eu-west-1` |
| `BEDROCK_MODEL` | `modelId` | `anthropic.claude-haiku-4-5-20251001-v1:0` |
| `PROMPT_CACHING_ENABLED` | `promptCaching` | `true` or `false` |
| `API_KEY` | — | Bearer token for client auth |
| `ENV_NAME` | — | Environment name (enables DynamoDB config) |

To change these, update your `.tfvars` and run `terraform apply`. The Lambda must be redeployed.

### Layer 3: DynamoDB Runtime Config (Hot-Reload)

**Table**: `cali-{ENV_NAME}-ai-connector-config`
**Key**: `configId = "default"`

This is the recommended way to tune LLM parameters without redeploying. Changes take effect within 5 minutes (cache TTL).

#### Writing config via AWS CLI

```bash
# Set all parameters
aws dynamodb put-item \
  --table-name cali-prod-ai-connector-config \
  --item '{
    "configId": {"S": "default"},
    "region": {"S": "us-east-1"},
    "modelId": {"S": "anthropic.claude-sonnet-4-20250514-v1:0"},
    "temperature": {"N": "0.7"},
    "maxTokens": {"N": "1024"},
    "topP": {"N": "1.0"}
  }'

# Or just override specific values (others keep their env/default values)
aws dynamodb put-item \
  --table-name cali-prod-ai-connector-config \
  --item '{
    "configId": {"S": "default"},
    "temperature": {"N": "0.3"},
    "maxTokens": {"N": "2048"}
  }'
```

#### DynamoDB item schema

| Field | Type | Description |
|-------|------|-------------|
| `configId` | String (PK) | Always `"default"` |
| `region` | String | AWS region for Bedrock |
| `modelId` | String | Bedrock model identifier |
| `temperature` | Number | Sampling temperature (0-1) |
| `maxTokens` | Number | Max tokens per response |
| `topP` | Number | Nucleus sampling threshold |
| `promptCaching` | Boolean | Enable/disable prompt caching |

All fields except `configId` are optional. Only set the ones you want to override.

### Named Configs

By default, the proxy loads `configId = "default"` from DynamoDB. You can create **named configs** for different use cases (e.g., `voice-prod`, `voice-test`, `chat`, `dev`) and select them via the `?config=` query parameter on the Function URL:

```
https://<function-url>/?config=voice-prod
https://<function-url>/?config=chat
https://<function-url>/                     ← uses "default"
```

Named configs are **layered on top of the default config**. Any field not set in the named config inherits from `"default"` (which itself inherits from env vars and hardcoded defaults).

#### Example: separate voice and chat configs

```bash
# Default config — shared baseline
aws dynamodb put-item \
  --table-name cali-prod-ai-connector-config \
  --item '{
    "configId": {"S": "default"},
    "modelId": {"S": "anthropic.claude-sonnet-4-20250514-v1:0"},
    "temperature": {"N": "0.7"},
    "promptCaching": {"BOOL": true}
  }'

# Voice-prod — lower temperature, higher token limit
aws dynamodb put-item \
  --table-name cali-prod-ai-connector-config \
  --item '{
    "configId": {"S": "voice-prod"},
    "temperature": {"N": "0.3"},
    "maxTokens": {"N": "2048"}
  }'

# Chat — higher temperature for more creative responses
aws dynamodb put-item \
  --table-name cali-prod-ai-connector-config \
  --item '{
    "configId": {"S": "chat"},
    "temperature": {"N": "0.9"}
  }'
```

Each client points to a different URL:
- Production voice: `https://<url>/?config=voice-prod`
- Chat: `https://<url>/?config=chat`
- Test: `https://<url>/?config=voice-test`

Each named config is cached independently with a 5-minute TTL.

### Layer 4: Per-Request Override

The client can send a `model` field in each request. If it looks like a Bedrock model ID (contains a dot, e.g., `anthropic.claude-sonnet-4-20250514-v1:0`), it's used directly. Otherwise, the config default applies.

`temperature`, `max_tokens`, and `top_p` in the request body override config values for that specific request.

### Configuration Resolution Example

```
Hardcoded:    modelId = "anthropic.claude-sonnet-4-20250514-v1:0"
Env var:      BEDROCK_MODEL = "anthropic.claude-haiku-4-5-20251001-v1:0"
DynamoDB:     modelId = "meta.llama3-70b-instruct-v1:0"
Request:      model = "custom-llm" (not a Bedrock ID)

Result:       modelId = "meta.llama3-70b-instruct-v1:0"  (DynamoDB wins)
```

```
Hardcoded:    temperature = 0.7
Env var:      (not set)
DynamoDB:     temperature = 0.3
Request:      temperature = 0.9

Result:       temperature = 0.9  (per-request wins over config)
```

## Prompt Caching

When `promptCaching` is enabled, the translator inserts Bedrock `cachePoint` blocks after:

1. **System messages** — the system prompt is identical every turn in a conversation
2. **Tool definitions** — tools are repeated in every request

This means Bedrock caches the system prompt and tools on the first turn, and subsequent turns read from cache at ~90% lower input token cost. The 5-minute cache TTL fits voice calls perfectly (turns happen every few seconds).

**Enabled by default in Terraform** (`ai_connector_prompt_caching = true`), **disabled in code defaults** so local/test environments don't use caching unless explicitly opted in.

Cache usage is reported in the response `usage` object:
- `prompt_tokens_details.cached_tokens` — tokens read from cache
- `cache_write_input_tokens` — tokens written to cache (first request)

To toggle at runtime via DynamoDB:
```bash
aws dynamodb put-item \
  --table-name cali-prod-ai-connector-config \
  --item '{
    "configId": {"S": "default"},
    "promptCaching": {"BOOL": false}
  }'
```

## Project Structure

```
backend/ai-connector/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                        # Lambda handler (streamifyResponse)
│   ├── config.ts                       # 3-layer config (defaults + env + DynamoDB)
│   ├── handler.ts                      # Core request lifecycle
│   ├── translator/
│   │   ├── openai-to-bedrock.ts        # Request: OpenAI messages -> Bedrock Converse input
│   │   └── bedrock-to-openai.ts        # Response: Bedrock stream -> OpenAI SSE chunks
│   ├── bedrock-client.ts               # BedrockRuntimeClient + ConverseStreamCommand
│   ├── auth.ts                         # Bearer token validation
│   └── types/
│       └── openai.d.ts                 # OpenAI ChatCompletion types
├── __tests__/
│   ├── config.test.ts
│   ├── handler.test.ts
│   ├── openai-to-bedrock.test.ts
│   ├── bedrock-to-openai.test.ts
│   └── auth.test.ts
```

## Translation Reference

### OpenAI -> Bedrock (Request)

| OpenAI | Bedrock Converse |
|--------|-----------------|
| `messages[role:"system"]` | Top-level `system` parameter |
| `messages[role:"user"]` | `{ role: "user", content: [{ text: "..." }] }` |
| `messages[role:"assistant"]` | `{ role: "assistant", content: [{ text: "..." }] }` |
| `messages[role:"assistant"].tool_calls` | `content: [{ toolUse: { toolUseId, name, input } }]` |
| `messages[role:"tool"]` | Merged into `user` message as `toolResult` content blocks |
| `tools[].function` | `toolConfig.tools[].toolSpec` |
| `tool_choice` | `toolConfig.toolChoice` (auto/any/tool) |
| `temperature`, `max_tokens`, `top_p` | `inferenceConfig` |

### Bedrock -> OpenAI (SSE Response)

| Bedrock Event | OpenAI SSE Chunk |
|---------------|-----------------|
| `contentBlockDelta` (text) | `delta.content` |
| `contentBlockStart` (toolUse) | `delta.tool_calls[i]` with id and name |
| `contentBlockDelta` (toolUse) | `delta.tool_calls[i].function.arguments` |
| `contentBlockStop` | (ignored, no OpenAI equivalent) |
| `messageStop` | `finish_reason` + `data: [DONE]` |
| `metadata` | `usage` object |

## Development

```bash
npm install
npm run build
npm test
npm run package   # Creates release/ai-connector-latest.zip for S3
```

## Deployment

1. **Build and upload artifact**:
   ```bash
   npm run package
   aws s3 cp release/ai-connector-latest.zip s3://<artefacts-bucket>/ai-connector/ai-connector-latest.zip
   ```

2. **Set Terraform variables** in your `.tfvars`:
   ```hcl
   ai_connector_api_key        = "your-secure-random-key"
   ai_connector_bedrock_region = "us-east-1"
   ai_connector_bedrock_model  = "anthropic.claude-sonnet-4-20250514-v1:0"
   ```

3. **Apply Terraform**: `terraform apply`

4. **Note the Function URL** from Terraform output: `ai_connector_function_url`

## Client Configuration

Point your OpenAI-compatible client at the Lambda Function URL with a `Bearer` token matching `API_KEY`:

```
POST <FUNCTION_URL>/
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "model": "anthropic.claude-sonnet-4-20250514-v1:0",
  "stream": true,
  "messages": [...]
}
```

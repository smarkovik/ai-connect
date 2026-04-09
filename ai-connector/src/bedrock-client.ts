import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { BedrockConverseInput } from "./translator/openai-to-bedrock";
import { getBedrockConfig } from "./config";

let client: BedrockRuntimeClient | null = null;
let clientRegion: string | null = null;

async function getClient(): Promise<BedrockRuntimeClient> {
  const config = await getBedrockConfig();
  // Recreate client if region changed (e.g., DynamoDB config update)
  if (!client || clientRegion !== config.region) {
    client = new BedrockRuntimeClient({ region: config.region });
    clientRegion = config.region;
  }
  return client;
}

/**
 * Invokes Bedrock ConverseStream and returns the async iterable stream.
 */
export async function invokeBedrockStream(
  input: BedrockConverseInput
): Promise<AsyncIterable<ConverseStreamOutput>> {
  const bedrockClient = await getClient();
  const command = new ConverseStreamCommand(
    input as unknown as ConverseStreamCommandInput
  );
  const response = await bedrockClient.send(command);

  if (!response.stream) {
    throw new Error("Bedrock returned no stream");
  }

  return response.stream;
}

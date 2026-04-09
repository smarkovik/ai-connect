/**
 * Slack error reporting for ai-connector.
 *
 * Sends fatal error notifications to the configured Slack incoming webhook.
 * Never throws — Slack failures must not break the main request flow.
 */

const ERROR_SLACK_CHANNEL = process.env.AI_CONNECTOR_ERROR_SLACK_CHANNEL;
const ENV_NAME = process.env.AI_CONNECTOR_ENV_NAME || "unknown";

export interface ErrorContext {
  /** The operation being performed when the error occurred */
  operation: string;
  /** The error message */
  error: string;
  /** The named config in use (if any) */
  configName?: string;
  /** The Bedrock model being called */
  model?: string;
  /** Additional details for debugging */
  details?: Record<string, unknown>;
}

/**
 * Reports a fatal error to the configured Slack incoming webhook.
 * Silently skips if AI_CONNECTOR_ERROR_SLACK_CHANNEL is not set.
 */
export async function reportErrorToSlack(
  context: ErrorContext
): Promise<void> {
  if (!ERROR_SLACK_CHANNEL) return;

  const lines = [
    `*Source:* ai-connector`,
    `*Env:* ${ENV_NAME.toUpperCase()}`,
    `*Operation:* ${context.operation}`,
    `*Error:* ${context.error}`,
  ];

  if (context.configName) lines.push(`*Config:* ${context.configName}`);
  if (context.model) lines.push(`*Model:* ${context.model}`);
  if (context.details && Object.keys(context.details).length > 0) {
    lines.push(`*Details:* \`\`\`${JSON.stringify(context.details, null, 2)}\`\`\``);
  }

  await fetch(ERROR_SLACK_CHANNEL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: lines.join("\n") }),
  });
}

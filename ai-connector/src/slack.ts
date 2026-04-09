/**
 * Slack error reporting for ai-connector.
 *
 * Sends fatal error notifications to the configured Slack errors channel.
 * Uses the shared reportToSlack from @callifly/common.
 *
 * Never throws — Slack failures must not break the main request flow.
 */

import { reportToSlack } from "@callifly/common";

const ERROR_SLACK_CHANNEL = process.env.ERROR_SLACK_CHANNEL;
const ENV_NAME = process.env.ENV_NAME || "unknown";

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
 * Reports a fatal error to the configured Slack errors channel.
 *
 * Silently skips if the channel isn't configured or in dev environment.
 */
export async function reportErrorToSlack(
  context: ErrorContext
): Promise<void> {
  if (!ERROR_SLACK_CHANNEL) return;

  const bodyParts = [
    `*Source:* ai-connector`,
    `*Operation:* ${context.operation}`,
    `*Error:* ${context.error}`,
  ];

  if (context.configName) {
    bodyParts.push(`*Config:* ${context.configName}`);
  }
  if (context.model) {
    bodyParts.push(`*Model:* ${context.model}`);
  }
  if (context.details && Object.keys(context.details).length > 0) {
    bodyParts.push(
      `*Details:* \`\`\`${JSON.stringify(context.details, null, 2)}\`\`\``
    );
  }

  await reportToSlack(
    {
      name: `🤖 [${ENV_NAME.toUpperCase()}] AI Connector Error 🤖`,
      url: ERROR_SLACK_CHANNEL,
    },
    bodyParts.join("\n")
  );
}

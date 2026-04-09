#!/usr/bin/env node

/**
 * Seed AI Connector configs to DynamoDB from the configs/ folder.
 *
 * Reads every .json file in configs/, then PutItem (upsert) each
 * into the {AI_CONNECTOR_ENV_NAME}-ai-connector-config table.
 *
 * Usage:
 *   AI_CONNECTOR_ENV_NAME=dev node scripts/seed-configs.js
 *   AI_CONNECTOR_ENV_NAME=prod AI_CONNECTOR_AWS_REGION=eu-central-1 node scripts/seed-configs.js
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const fs = require("fs");
const path = require("path");

const ENV_NAME = process.env.AI_CONNECTOR_ENV_NAME;
if (!ENV_NAME) {
  console.error("AI_CONNECTOR_ENV_NAME environment variable is required (e.g. dev, staging, prod)");
  process.exit(1);
}

const TABLE_NAME = `${ENV_NAME}-ai-connector-config`;
const CONFIGS_DIR = path.resolve(__dirname, "..", "configs");
const REGION = process.env.AI_CONNECTOR_AWS_REGION || process.env.AWS_REGION || "eu-central-1";

const docClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION })
);

async function seedConfigs() {
  const files = fs
    .readdirSync(CONFIGS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.log("No config files found in configs/");
    return;
  }

  console.log(`Seeding ${files.length} config(s) to ${TABLE_NAME} ...`);

  for (const file of files) {
    const filePath = path.join(CONFIGS_DIR, file);
    const raw = fs.readFileSync(filePath, "utf-8");
    const item = JSON.parse(raw);

    if (!item.configId) {
      console.warn(`  SKIP ${file} — missing configId`);
      continue;
    }

    await docClient.send(
      new PutCommand({ TableName: TABLE_NAME, Item: item })
    );

    console.log(`  OK   ${file} -> configId="${item.configId}"`);
  }

  console.log("Done.");
}

seedConfigs().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

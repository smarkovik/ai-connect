/**
 * Seed mock Eva feedback tickets into DynamoDB for local testing.
 *
 * Usage:
 *   ASSISTANT_ID=<id> node scripts/seed-eva-tickets.js
 *
 * Requires AWS credentials configured for the dev environment.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");

const ENV_NAME = process.env.ENV_NAME || "dev";
const TABLE_NAME = `cali-${ENV_NAME}-system-tickets`;
const REGION = process.env.AWS_REGION || "eu-central-1";

// Default assistant — override with ASSISTANT_ID env var
const ASSISTANT_ID = process.env.ASSISTANT_ID || "449f048d-8395-4fab-bf47-6eb8a53c7662";
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || "Demo Assistant";
const ORG_ID = process.env.ORG_ID || "48e748cc-f8a4-4b13-83aa-a78774389176";

const client = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(client);

const now = Date.now();
const DAY = 86_400_000;

/** Realistic Eva tickets covering common voice AI issues */
const MOCK_TICKETS = [
  // Critical
  {
    type: "assistant-issue",
    ticketSource: "LLM",
    priority: "critical",
    status: "pending",
    issue: "Agent fabricates pricing information not present in knowledge base",
    possible_fix: "Add explicit guardrail: 'Never invent pricing. If unsure, say you will check and follow up.'",
    description: "In 5 recent calls, the agent quoted prices that don't exist in the product catalog. Customers were given incorrect quotes leading to complaints.",
    occurrenceCount: 5,
    tags: ["hallucination", "pricing", "guardrail"],
    daysAgo: 1,
  },
  {
    type: "assistant-issue",
    ticketSource: "LLM",
    priority: "critical",
    status: "pending",
    issue: "Agent continues conversation after customer explicitly asks to end the call",
    possible_fix: "Strengthen end-call detection: add 'I want to hang up', 'stop calling me', 'end this call' to endCallPhrases",
    description: "Multiple customers reported feeling trapped in the conversation. The agent ignores polite and direct requests to end the call.",
    occurrenceCount: 8,
    tags: ["end-call", "guardrail", "UX"],
    daysAgo: 2,
  },
  // High
  {
    type: "assistant-issue",
    ticketSource: "LLM",
    priority: "high",
    status: "pending",
    issue: "Agent doesn't handle pricing objections effectively",
    possible_fix: "Add an objection handling section to the prompt with specific rebuttals for common pricing concerns",
    description: "When customers say 'that's too expensive' or 'I can't afford that', the agent either goes silent or repeats the same pitch.",
    occurrenceCount: 12,
    tags: ["objections", "sales", "prompt"],
    daysAgo: 3,
  },
  {
    type: "assistant-issue",
    ticketSource: "SYSTEM",
    priority: "high",
    status: "in_progress",
    issue: "High voicemail rate during morning hours (9-11am)",
    possible_fix: "Consider adjusting call scheduling to afternoon slots or adding a retry strategy for morning no-answers",
    description: "42% of calls between 9-11am go to voicemail vs 18% in the afternoon. The agent leaves a voicemail but it's too long and generic.",
    occurrenceCount: 25,
    tags: ["voicemail", "scheduling", "timing"],
    daysAgo: 5,
  },
  {
    type: "user-complaint",
    ticketSource: "USER",
    priority: "high",
    status: "pending",
    issue: "Agent speaks too fast for non-native speakers",
    possible_fix: "Add instruction: 'Speak at a moderate pace. If the caller seems confused, slow down and simplify your language.'",
    description: "3 customer complaints about the agent speaking too quickly. All callers were non-native French speakers.",
    occurrenceCount: 3,
    tags: ["pace", "accessibility", "language"],
    daysAgo: 4,
  },
  {
    type: "assistant-issue",
    ticketSource: "KB",
    priority: "high",
    status: "pending",
    issue: "Knowledge base answers are too verbose — agent reads entire paragraphs",
    possible_fix: "Add instruction: 'When using knowledge base results, summarize in 1-2 sentences. Never read long passages verbatim.'",
    description: "Agent retrieves correct KB content but reads it word-for-word, creating an unnatural monologue that loses the caller's attention.",
    occurrenceCount: 7,
    tags: ["knowledge-base", "verbosity", "prompt"],
    daysAgo: 6,
  },
  // Medium
  {
    type: "assistant-issue",
    ticketSource: "LLM",
    priority: "medium",
    status: "resolved",
    issue: "Agent sometimes switches to English mid-conversation",
    possible_fix: "Reinforce language constraint: 'You MUST respond in French at all times, regardless of the caller's language.'",
    description: "When callers use English words or technical terms, the agent occasionally switches to English for 1-2 sentences before reverting.",
    occurrenceCount: 4,
    tags: ["language", "french", "consistency"],
    daysAgo: 10,
    resolvedDaysAgo: 7,
  },
  {
    type: "assistant-issue",
    ticketSource: "TOOL",
    priority: "medium",
    status: "pending",
    issue: "Calendar booking tool fails silently — agent doesn't inform caller",
    possible_fix: "Add error handling instruction: 'If a booking fails, apologize and offer to schedule manually via email.'",
    description: "When the calendar API returns an error, the agent just moves on without acknowledging the failed booking attempt.",
    occurrenceCount: 3,
    tags: ["tools", "error-handling", "booking"],
    daysAgo: 8,
  },
  {
    type: "assistant-issue",
    ticketSource: "LATENCY",
    priority: "medium",
    status: "pending",
    issue: "Long pauses (3-5s) before agent responds to complex questions",
    possible_fix: "Add a filler response instruction: 'For complex questions, say \"Let me think about that...\" before processing.'",
    description: "Callers interpret silence as a dropped call. 2 callers hung up during these pauses.",
    occurrenceCount: 6,
    tags: ["latency", "UX", "filler"],
    daysAgo: 7,
  },
  // Low
  {
    type: "assistant-issue",
    ticketSource: "LLM",
    priority: "low",
    status: "resolved",
    issue: "Agent uses overly formal language with younger callers",
    possible_fix: "Add tone adaptation: 'Match the caller's register — if they use informal language, respond in a friendly but professional tone.'",
    description: "Feedback from 2 callers under 25 who found the agent 'robotic' and 'too stiff'.",
    occurrenceCount: 2,
    tags: ["tone", "adaptation", "UX"],
    daysAgo: 14,
    resolvedDaysAgo: 10,
  },
  {
    type: "support-ticket",
    ticketSource: "SYSTEM",
    priority: "low",
    status: "wont_fix",
    issue: "Background noise detection triggers false interruptions",
    possible_fix: "Increase silence timeout or adjust interruption sensitivity in the voice client config",
    description: "In noisy environments, the agent interprets background sounds as speech and interrupts the caller.",
    occurrenceCount: 2,
    tags: ["interruptions", "noise", "config"],
    daysAgo: 20,
  },
  {
    type: "assistant-issue",
    ticketSource: "LLM",
    priority: "low",
    status: "pending",
    issue: "Agent repeats the caller's name too frequently",
    possible_fix: "Add guideline: 'Use the caller's name at most twice — once at greeting and once at closing.'",
    description: "Minor annoyance reported by 1 caller who said the agent used their name in every sentence.",
    occurrenceCount: 1,
    tags: ["personalization", "UX", "prompt"],
    daysAgo: 12,
  },
];

async function seedTickets() {
  console.log(`Seeding ${MOCK_TICKETS.length} mock Eva tickets...`);
  console.log(`  Table:     ${TABLE_NAME}`);
  console.log(`  Assistant: ${ASSISTANT_ID}`);
  console.log(`  Org:       ${ORG_ID}\n`);

  for (const ticket of MOCK_TICKETS) {
    const ticketId = crypto.randomUUID();
    const createdAt = now - ticket.daysAgo * DAY + Math.floor(Math.random() * DAY);
    const ttl = Math.floor((createdAt + 180 * DAY) / 1000); // 180 days TTL in seconds

    const item = {
      ticketId,
      createdAt,
      assistantId: ASSISTANT_ID,
      assistantName: ASSISTANT_NAME,
      organizationId: ORG_ID,
      type: ticket.type,
      ticketSource: ticket.ticketSource,
      issue: ticket.issue,
      possible_fix: ticket.possible_fix,
      description: ticket.description,
      status: ticket.status,
      priority: ticket.priority,
      occurrenceCount: ticket.occurrenceCount,
      tags: ticket.tags,
      ttl,
    };

    // Add resolution fields for resolved/wont_fix tickets
    if (ticket.status === "resolved" || ticket.status === "wont_fix") {
      item.resolvedAt = now - (ticket.resolvedDaysAgo || 1) * DAY;
      item.resolvedBy = "seed-script";
      item.resolvedByName = "Auto-resolved";
      if (ticket.status === "resolved") {
        item.resolution = "Fixed in prompt update";
      }
    }

    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    console.log(`  ✓ [${ticket.priority}] ${ticket.issue.slice(0, 60)}...`);
  }

  console.log(`\n✅ Done — ${MOCK_TICKETS.length} tickets seeded.`);
}

seedTickets().catch((err) => {
  console.error("❌ Failed to seed tickets:", err.message);
  process.exit(1);
});

/**
 * Seed mock call reports (end of call reports) into DynamoDB for local testing.
 *
 * Usage:
 *   ASSISTANT_ID=<id> node scripts/seed-call-reports.js
 *
 * Requires AWS credentials configured for the dev environment.
 */

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
} = require("@aws-sdk/lib-dynamodb");
const crypto = require("crypto");

const ENV_NAME = process.env.ENV_NAME || "dev";
const TABLE_NAME = `cali-${ENV_NAME}-processed-call-logs`;
const REGION = process.env.AWS_REGION || "eu-central-1";

const ASSISTANT_ID =
  process.env.ASSISTANT_ID || "449f048d-8395-4fab-bf47-6eb8a53c7662";
const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || "Cause \u00e0 effet - Pre rec G\u00e9n\u00e9rique";
const ORG_ID =
  process.env.ORG_ID || "2fe4d308-aff4-4dde-a8f8-0917d6f854b0";

const client = new DynamoDBClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(client);

const now = Date.now();
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Realistic end-of-call report data */
const MOCK_CALLS = [
  // --- Successful calls ---
  {
    offsetDays: 0,
    duration: 185,
    customerNumber: "+33612345678",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "assistant-ended-call",
    callType: "inboundPhoneCall",
    cost: "0.32",
    successEvaluation: "true",
    summary:
      "Le client a appel\u00e9 pour se renseigner sur les tarifs de la formation coaching de vie. L\u2019agent a pr\u00e9sent\u00e9 les diff\u00e9rents forfaits et a r\u00e9pondu aux questions sur le financement CPF. Rendez-vous de d\u00e9couverte pris pour le lendemain \u00e0 14h.",
    analysis: {
      summary:
        "Client int\u00e9ress\u00e9 par formation coaching de vie. RDV d\u00e9couverte pris.",
      structuredData: {
        intent: "information_formation",
        outcome: "rdv_pris",
        satisfaction: "high",
      },
      successEvaluation: "true",
    },
    transcript:
      "Agent: Bonjour, bienvenue chez Cause \u00e0 effet, je suis l\u2019assistante virtuelle. Comment puis-je vous aider ?\nClient: Bonjour, j\u2019aimerais avoir des informations sur vos formations en coaching.\nAgent: Bien s\u00fbr ! Nous proposons plusieurs parcours de formation...",
  },
  {
    offsetDays: 0,
    duration: 142,
    customerNumber: "+33698765432",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "assistant-ended-call",
    callType: "inboundPhoneCall",
    cost: "0.24",
    successEvaluation: "true",
    summary:
      "Appel d\u2019un ancien \u00e9l\u00e8ve souhaitant s\u2019inscrire \u00e0 un atelier avanc\u00e9. L\u2019agent a identifi\u00e9 le profil client, confirm\u00e9 la disponibilit\u00e9 et envoy\u00e9 le lien d\u2019inscription par SMS.",
    analysis: {
      summary: "Ancien \u00e9l\u00e8ve, inscription atelier avanc\u00e9 confirm\u00e9e.",
      structuredData: {
        intent: "inscription_atelier",
        outcome: "inscription_confirmee",
        satisfaction: "high",
      },
      successEvaluation: "true",
    },
    transcript:
      "Agent: Bonjour et bienvenue chez Cause \u00e0 effet !\nClient: Bonjour, je suis d\u00e9j\u00e0 client chez vous, j\u2019aimerais m\u2019inscrire au prochain atelier avanc\u00e9...",
  },
  {
    offsetDays: -1,
    duration: 210,
    customerNumber: "+33645678901",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "assistant-ended-call",
    callType: "inboundPhoneCall",
    cost: "0.36",
    successEvaluation: "true",
    summary:
      "Prospect int\u00e9ress\u00e9 par la reconversion professionnelle. L\u2019agent a expliqu\u00e9 le programme de formation certifiante et a planifi\u00e9 un appel de suivi avec un conseiller humain pour la semaine prochaine.",
    analysis: {
      summary:
        "Prospect reconversion professionnelle. Appel suivi planifi\u00e9.",
      structuredData: {
        intent: "reconversion_pro",
        outcome: "suivi_planifie",
        satisfaction: "high",
      },
      successEvaluation: "true",
    },
    transcript:
      "Agent: Bonjour, Cause \u00e0 effet, comment puis-je vous aider aujourd\u2019hui ?\nClient: J\u2019envisage une reconversion et on m\u2019a parl\u00e9 de vos formations certifiantes...",
  },
  // --- Partially successful calls ---
  {
    offsetDays: -1,
    duration: 95,
    customerNumber: "+33678901234",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "customer-ended-call",
    callType: "inboundPhoneCall",
    cost: "0.16",
    successEvaluation: "false",
    summary:
      "Le client a demand\u00e9 des d\u00e9tails sp\u00e9cifiques sur les prix qui n\u2019\u00e9taient pas dans la base de connaissances. L\u2019agent a tent\u00e9 de rediriger vers un conseiller mais le client a raccroch\u00e9 avant le transfert.",
    analysis: {
      summary:
        "Client a raccroch\u00e9 \u2014 prix sp\u00e9cifiques non disponibles dans la KB.",
      structuredData: {
        intent: "information_prix",
        outcome: "client_raccroche",
        satisfaction: "low",
      },
      successEvaluation: "false",
    },
    transcript:
      "Agent: Bonjour !\nClient: Oui bonjour, combien co\u00fbte exactement la formation coaching niveau 2 ?\nAgent: Je vais v\u00e9rifier cette information pour vous...\nClient: \u2026 Bon, je rappellerai.\n[Appel termin\u00e9 par le client]",
  },
  {
    offsetDays: -2,
    duration: 67,
    customerNumber: "+33654321098",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "customer-ended-call",
    callType: "inboundPhoneCall",
    cost: "0.12",
    successEvaluation: "false",
    summary:
      "Appel tr\u00e8s court. Le client a demand\u00e9 \u00e0 parler \u00e0 un humain imm\u00e9diatement. L\u2019agent a propos\u00e9 de l\u2019aide mais le client a insist\u00e9 et a raccroch\u00e9 quand l\u2019agent n\u2019a pas pu transf\u00e9rer directement.",
    analysis: {
      summary:
        "Client voulait un humain, a raccroch\u00e9. Pas de transfert direct possible.",
      structuredData: {
        intent: "parler_humain",
        outcome: "client_raccroche",
        satisfaction: "very_low",
      },
      successEvaluation: "false",
    },
    transcript:
      "Agent: Bonjour, bienvenue chez Cause \u00e0 effet !\nClient: Bonjour, est-ce que je peux parler \u00e0 quelqu\u2019un s\u2019il vous pla\u00eet ?\nAgent: Bien s\u00fbr, je peux vous aider avec la plupart des questions. Que puis-je...\nClient: Non, je voudrais parler \u00e0 une vraie personne.\n[Appel termin\u00e9 par le client]",
  },
  // --- Voicemail / no-answer ---
  {
    offsetDays: -2,
    duration: 28,
    customerNumber: "+33687654321",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "voicemail",
    callType: "outboundPhoneCall",
    cost: "0.05",
    successEvaluation: "N/A",
    summary: "Appel sortant tomb\u00e9 sur la messagerie vocale. Message non laiss\u00e9.",
    analysis: {
      summary: "Messagerie vocale \u2014 pas de r\u00e9ponse.",
      structuredData: {
        intent: "suivi_prospect",
        outcome: "voicemail",
        satisfaction: "N/A",
      },
      successEvaluation: "N/A",
    },
    transcript: "[Messagerie vocale d\u00e9tect\u00e9e \u2014 appel termin\u00e9]",
  },
  {
    offsetDays: -3,
    duration: 31,
    customerNumber: "+33676543210",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "voicemail",
    callType: "outboundPhoneCall",
    cost: "0.05",
    successEvaluation: "N/A",
    summary: "Tentative d\u2019appel sortant pour suivi inscription. Messagerie vocale.",
    analysis: {
      summary: "Voicemail \u2014 suivi inscription.",
      structuredData: {
        intent: "suivi_inscription",
        outcome: "voicemail",
        satisfaction: "N/A",
      },
      successEvaluation: "N/A",
    },
    transcript: "[Messagerie vocale d\u00e9tect\u00e9e \u2014 appel termin\u00e9]",
  },
  // --- Technical issues ---
  {
    offsetDays: -3,
    duration: 12,
    customerNumber: "+33665432109",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "assistant-error",
    callType: "inboundPhoneCall",
    cost: "0.02",
    successEvaluation: "false",
    summary:
      "L\u2019appel s\u2019est termin\u00e9 pr\u00e9matur\u00e9ment en raison d\u2019une erreur technique c\u00f4t\u00e9 agent. Le client n\u2019a pas pu obtenir d\u2019assistance.",
    analysis: {
      summary: "Erreur technique \u2014 appel coup\u00e9.",
      structuredData: {
        intent: "unknown",
        outcome: "erreur_technique",
        satisfaction: "very_low",
      },
      successEvaluation: "false",
    },
    transcript:
      "Agent: Bonjour, bienvenue chez\u2026\n[Erreur syst\u00e8me \u2014 appel termin\u00e9]",
  },
  // --- Long successful call ---
  {
    offsetDays: -4,
    duration: 340,
    customerNumber: "+33643210987",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "assistant-ended-call",
    callType: "inboundPhoneCall",
    cost: "0.58",
    successEvaluation: "true",
    summary:
      "Appel d\u00e9taill\u00e9 avec un prospect qui h\u00e9sitait entre deux formations. L\u2019agent a fait une comparaison compl\u00e8te, r\u00e9pondu \u00e0 toutes les objections prix, et a r\u00e9ussi \u00e0 prendre un RDV d\u00e9couverte. Le client \u00e9tait tr\u00e8s satisfait de la qualit\u00e9 des r\u00e9ponses.",
    analysis: {
      summary:
        "Comparaison formations, objections trait\u00e9es, RDV pris. Client satisfait.",
      structuredData: {
        intent: "comparaison_formations",
        outcome: "rdv_pris",
        satisfaction: "very_high",
      },
      successEvaluation: "true",
    },
    transcript:
      "Agent: Bonjour et bienvenue chez Cause \u00e0 effet ! En quoi puis-je vous aider ?\nClient: Bonjour, j\u2019h\u00e9site entre la formation coaching de vie et la formation PNL...",
  },
  // --- Recent calls today ---
  {
    offsetDays: 0,
    duration: 120,
    customerNumber: "+33632109876",
    phoneNumber: "+33756892165",
    phoneName: "Cause \u00e0 effet - Ligne 1",
    callEndReason: "assistant-ended-call",
    callType: "inboundPhoneCall",
    cost: "0.20",
    successEvaluation: "true",
    summary:
      "Client existant qui appelait pour confirmer les horaires de son prochain atelier. Information donn\u00e9e rapidement, client satisfait.",
    analysis: {
      summary: "Confirmation horaires atelier \u2014 rapide et efficace.",
      structuredData: {
        intent: "confirmation_horaires",
        outcome: "information_fournie",
        satisfaction: "high",
      },
      successEvaluation: "true",
    },
    transcript:
      "Agent: Bonjour !\nClient: Bonjour, je voulais juste confirmer l\u2019heure de l\u2019atelier de samedi prochain.\nAgent: Bien s\u00fbr, votre atelier est pr\u00e9vu samedi \u00e0 10h...",
  },
];

async function seed() {
  console.log(`Seeding ${MOCK_CALLS.length} mock call reports...`);
  console.log(`  Table:     ${TABLE_NAME}`);
  console.log(`  Assistant: ${ASSISTANT_ID}`);
  console.log(`  Org:       ${ORG_ID}\n`);

  for (const call of MOCK_CALLS) {
    const callId = crypto.randomUUID();
    const timestamp = now + call.offsetDays * DAY - Math.floor(Math.random() * 4 * HOUR);
    const startedAt = timestamp - call.duration * 1000;

    const item = {
      callId,
      timestamp,
      assistantId: ASSISTANT_ID,
      assistantName: ASSISTANT_NAME,
      organizationId: ORG_ID,

      customerNumber: call.customerNumber,
      phoneNumber: call.phoneNumber,
      phoneName: call.phoneName,

      callEndReason: call.callEndReason,
      callType: call.callType,
      startedAt,
      endedAt: timestamp,

      cost: call.cost,
      duration: call.duration,
      billableMins: Math.ceil(call.duration / 60),

      summary: call.summary,
      transcript: call.transcript,
      recordingUrl: "N/A",
      stereoRecordingUrl: "N/A",
      analysis: call.analysis,
      structuredData: call.analysis.structuredData || {},
      successEvaluation: call.successEvaluation,
      structuredOutputs: {},
      overrideVariables: {},
    };

    await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
    const label = `[${call.callEndReason}] ${call.summary.substring(0, 60)}...`;
    console.log(`  \u2713 ${label}`);
  }

  console.log(`\n\u2705 Done \u2014 ${MOCK_CALLS.length} call reports seeded.`);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

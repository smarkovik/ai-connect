/**
 * Authentication module for the AI Connector.
 *
 * Supports two auth modes:
 * 1. **Cognito JWT** — for dashboard users (verified via JWKS signature check)
 * 2. **Static API key** — for service-to-service calls
 *
 * The caller is identified by `AuthResult.identity` which contains userId
 * and companyId when a Cognito JWT is used.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AuthError {
  statusCode: number;
  message: string;
}

export interface AuthIdentity {
  userId: string;
  companyId: string;
  email?: string;
}

export type AuthResult =
  | { ok: true; identity: AuthIdentity | null }
  | { ok: false; error: AuthError };

// ─── JWKS cache ─────────────────────────────────────────────────────────────

interface JWK {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
}

interface JWKSResponse {
  keys: JWK[];
}

let jwksCache: JWKSResponse | null = null;
let jwksCacheExpiry = 0;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetch the Cognito JWKS (JSON Web Key Set) for signature verification.
 * Cached in memory for 1 hour.
 */
async function getJWKS(userPoolId: string, region: string): Promise<JWKSResponse> {
  const now = Date.now();
  if (jwksCache && now < jwksCacheExpiry) return jwksCache;

  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  const res = await fetch(`${issuer}/.well-known/jwks.json`);
  if (!res.ok) throw new Error(`Failed to fetch JWKS: ${res.status}`);

  jwksCache = (await res.json()) as JWKSResponse;
  jwksCacheExpiry = now + JWKS_CACHE_TTL_MS;
  return jwksCache;
}

// ─── JWT helpers (no external deps) ─────────────────────────────────────────

/** Base64url decode to Buffer */
function base64urlDecode(input: string): Buffer {
  let str = input.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4 !== 0) str += "=";
  return Buffer.from(str, "base64");
}

/** Convert a JWK RSA key to a PEM public key for crypto.verify */
function jwkToPem(jwk: JWK): string {
  const n = base64urlDecode(jwk.n);
  const e = base64urlDecode(jwk.e);

  // ASN.1 DER encoding for RSA public key
  const encodedN = n[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), n]) : n;
  const encodedE = e[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), e]) : e;

  const nSeq = Buffer.concat([
    Buffer.from([0x02]),
    derLength(encodedN.length),
    encodedN,
  ]);
  const eSeq = Buffer.concat([
    Buffer.from([0x02]),
    derLength(encodedE.length),
    encodedE,
  ]);
  const pubKeySeq = Buffer.concat([
    Buffer.from([0x30]),
    derLength(nSeq.length + eSeq.length),
    nSeq,
    eSeq,
  ]);

  // RSA OID: 1.2.840.113549.1.1.1
  const rsaOid = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);

  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    derLength(pubKeySeq.length + 1),
    Buffer.from([0x00]),
    pubKeySeq,
  ]);

  const totalSeq = Buffer.concat([
    Buffer.from([0x30]),
    derLength(rsaOid.length + bitString.length),
    rsaOid,
    bitString,
  ]);

  const b64 = totalSeq.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

/** Encode an ASN.1 DER length */
function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

/**
 * Verify a Cognito JWT — checks signature, expiry, issuer, and token_use.
 * Returns the decoded payload or throws on failure.
 */
async function verifyCognitoJWT(
  token: string,
  userPoolId: string,
  region: string
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT structure");

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(base64urlDecode(headerB64).toString("utf8"));
  const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    throw new Error("Token expired");
  }

  // Check issuer
  const expectedIssuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  if (payload.iss !== expectedIssuer) {
    throw new Error(`Invalid issuer: ${payload.iss}`);
  }

  // Check token_use (accept both access and id tokens)
  if (payload.token_use !== "access" && payload.token_use !== "id") {
    throw new Error(`Invalid token_use: ${payload.token_use}`);
  }

  // Verify signature using JWKS
  const jwks = await getJWKS(userPoolId, region);
  const key = jwks.keys.find((k) => k.kid === header.kid);
  if (!key) throw new Error(`Key ${header.kid} not found in JWKS`);

  const pem = jwkToPem(key);
  const { createVerify } = await import("crypto");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  const signatureBuffer = base64urlDecode(signatureB64);

  if (!verifier.verify(pem, signatureBuffer)) {
    throw new Error("Invalid JWT signature");
  }

  return payload;
}

// ─── Main auth function ─────────────────────────────────────────────────────

/**
 * Validates the Authorization header.
 *
 * Tries Cognito JWT first. Falls back to static API key for service-to-service calls.
 * Returns identity (userId + companyId) when JWT is used.
 */
export async function validateAuth(
  authorizationHeader: string | undefined
): Promise<AuthResult> {
  if (!authorizationHeader) {
    return { ok: false, error: { statusCode: 401, message: "Missing Authorization header" } };
  }

  const parts = authorizationHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
    return {
      ok: false,
      error: { statusCode: 401, message: "Invalid authorization scheme, expected Bearer" },
    };
  }

  const token = parts[1];

  // ─── Try static API key first (fast path for service-to-service) ────
  const apiKey = process.env.API_KEY;
  if (apiKey && token === apiKey) {
    return { ok: true, identity: null };
  }

  // ─── Try Cognito JWT ────────────────────────────────────────────────
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const region = process.env.DEFAULT_REGION || "eu-central-1";

  if (!userPoolId) {
    // No Cognito configured — reject if API key didn't match
    return { ok: false, error: { statusCode: 403, message: "Invalid credentials" } };
  }

  try {
    const payload = await verifyCognitoJWT(token, userPoolId, region);

    // Extract identity from Cognito claims
    const userId = (payload.sub as string) || "unknown";
    const groups = (payload["cognito:groups"] as string[]) || [];
    const companyId = groups[0] || "unknown";
    const email = (payload.email as string) || undefined;

    return { ok: true, identity: { userId, companyId, email } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "JWT validation failed";
    return { ok: false, error: { statusCode: 401, message: msg } };
  }
}

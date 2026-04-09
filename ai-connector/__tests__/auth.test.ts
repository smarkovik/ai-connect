import { validateAuth } from "../src/auth";

describe("validateAuth", () => {
  const VALID_KEY = "test-secret-key-123";

  beforeEach(() => {
    process.env.AI_CONNECTOR_API_KEY = VALID_KEY;
    // No Cognito configured — tests focus on the static API key path
    delete process.env.AI_CONNECTOR_COGNITO_POOL_ID;
  });

  afterEach(() => {
    delete process.env.AI_CONNECTOR_API_KEY;
    delete process.env.AI_CONNECTOR_COGNITO_POOL_ID;
  });

  it("returns ok with null identity for a valid static API key", async () => {
    const result = await validateAuth(`Bearer ${VALID_KEY}`);
    expect(result).toEqual({ ok: true, identity: null });
  });

  it("returns 401 error when Authorization header is missing", async () => {
    const result = await validateAuth(undefined);
    expect(result).toEqual({
      ok: false,
      error: { statusCode: 401, message: "Missing Authorization header" },
    });
  });

  it("returns 401 error when Authorization header is empty", async () => {
    const result = await validateAuth("");
    expect(result).toEqual({
      ok: false,
      error: { statusCode: 401, message: "Missing Authorization header" },
    });
  });

  it("returns 401 error when scheme is not Bearer", async () => {
    const result = await validateAuth(`Basic ${VALID_KEY}`);
    expect(result).toEqual({
      ok: false,
      error: { statusCode: 401, message: "Invalid authorization scheme, expected Bearer" },
    });
  });

  it("returns 403 error when token does not match and no Cognito configured", async () => {
    const result = await validateAuth("Bearer wrong-key");
    expect(result).toEqual({
      ok: false,
      error: { statusCode: 403, message: "Invalid credentials" },
    });
  });

  it("returns 403 error when AI_CONNECTOR_API_KEY env var is not set and no Cognito configured", async () => {
    delete process.env.AI_CONNECTOR_API_KEY;
    const result = await validateAuth(`Bearer ${VALID_KEY}`);
    expect(result).toEqual({
      ok: false,
      error: { statusCode: 403, message: "Invalid credentials" },
    });
  });

  it("handles Bearer prefix case-insensitively", async () => {
    const result = await validateAuth(`bearer ${VALID_KEY}`);
    expect(result).toEqual({ ok: true, identity: null });
  });
});

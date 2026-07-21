import crypto from "crypto";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signState(payload, secret) {
  return base64url(crypto.createHmac("sha256", secret).update(payload).digest());
}

function stateSecret() {
  return process.env.KAKAO_OAUTH_STATE_SECRET || process.env.KAKAO_REST_API_KEY || "";
}

function allowedReturnTo(raw) {
  const fallback = process.env.KAKAO_RETURN_TO || "https://logbook-tljs60.flutterflow.app/auth3";
  const value = String(raw || fallback).trim();
  const allowedOrigins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const parsed = new URL(value);
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(parsed.origin)) {
    throw new Error(`returnTo origin is not allowed: ${parsed.origin}`);
  }
  return parsed.toString();
}

function callbackUrl(req) {
  if (process.env.KAKAO_REDIRECT_URI) return process.env.KAKAO_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${req.headers.host}/api/kakaoCallback`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const restApiKey = process.env.KAKAO_REST_API_KEY || "";
    const secret = stateSecret();
    if (!restApiKey) throw new Error("KAKAO_REST_API_KEY is not configured");
    if (!secret) throw new Error("KAKAO_OAUTH_STATE_SECRET is not configured");

    const returnTo = allowedReturnTo(req.query?.returnTo);
    const payload = base64url(
      JSON.stringify({
        returnTo,
        exp: Date.now() + 10 * 60 * 1000,
        nonce: crypto.randomBytes(12).toString("hex"),
      })
    );
    const state = `${payload}.${signState(payload, secret)}`;

    const url = new URL("https://kauth.kakao.com/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", restApiKey);
    url.searchParams.set("redirect_uri", callbackUrl(req));
    url.searchParams.set("state", state);

    res.statusCode = 302;
    res.setHeader("Location", url.toString());
    res.end();
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

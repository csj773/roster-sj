import crypto from "crypto";
import { createFirebaseTokenFromKakaoAccessToken } from "./_kakaoFirebase.mjs";

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function setCors(req, res) {
  const allowedOrigins = String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origin = req.headers.origin || "";
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireApiKey(req) {
  const expected = process.env.KAKAO_AUTH_API_KEY || process.env.ROSTER_API_KEY || process.env.API_KEY || "";
  if (!expected) return { ok: false, status: 500, error: "KAKAO_AUTH_API_KEY or ROSTER_API_KEY is not configured" };
  const actual = req.headers["x-api-key"];
  if (!actual || !timingSafeEqualText(actual, expected)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  return { ok: true };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const apiKey = requireApiKey(req);
    if (!apiKey.ok) {
      json(res, apiKey.status, { error: apiKey.error });
      return;
    }

    const body = await readJsonBody(req);
    const accessToken = String(body.kakaoAccessToken || body.accessToken || "").trim();
    if (!accessToken) {
      json(res, 400, { error: "kakaoAccessToken is required" });
      return;
    }

    const { firebaseCustomToken, uid, email, displayName } =
      await createFirebaseTokenFromKakaoAccessToken(accessToken);
    json(res, 200, {
      ok: true,
      firebaseCustomToken,
      uid,
      email,
      displayName,
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

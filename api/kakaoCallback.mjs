import crypto from "crypto";
import { createFirebaseTokenFromKakaoAccessToken } from "./_kakaoFirebase.mjs";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function unbase64url(input) {
  const padded = String(input).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function stateSecret() {
  return process.env.KAKAO_OAUTH_STATE_SECRET || process.env.KAKAO_REST_API_KEY || "";
}

function signState(payload, secret) {
  return base64url(crypto.createHmac("sha256", secret).update(payload).digest());
}

function verifyState(state) {
  const [payload, signature] = String(state || "").split(".");
  const secret = stateSecret();
  if (!payload || !signature || !secret) throw new Error("Invalid Kakao state");
  const expected = signState(payload, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error("Invalid Kakao state signature");
  }
  const parsed = JSON.parse(unbase64url(payload));
  if (!parsed.exp || Date.now() > parsed.exp) throw new Error("Expired Kakao state");
  return parsed;
}

function callbackUrl(req) {
  if (process.env.KAKAO_REDIRECT_URI) return process.env.KAKAO_REDIRECT_URI;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${req.headers.host}/api/kakaoCallback`;
}

async function exchangeCodeForToken(req, code) {
  const restApiKey = process.env.KAKAO_REST_API_KEY || "";
  if (!restApiKey) throw new Error("KAKAO_REST_API_KEY is not configured");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: restApiKey,
    redirect_uri: callbackUrl(req),
    code,
  });
  if (process.env.KAKAO_CLIENT_SECRET) {
    body.set("client_secret", process.env.KAKAO_CLIENT_SECRET);
  }

  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error("Kakao authorization code exchange failed");
    error.details = data;
    throw error;
  }
  if (!data.access_token) throw new Error("Kakao token response did not include access_token");
  return data.access_token;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlResponse(res, status, state, body) {
  const returnTo = state?.returnTo || process.env.KAKAO_RETURN_TO || "https://logbook-tljs60.flutterflow.app/auth3";
  const origin = new URL(returnTo).origin;
  const payload = JSON.stringify({
    type: "pilotlog:kakaoAuth",
    ...body,
  });

  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Kakao Login</title></head>
<body>
<script>
const message = ${payload};
const targetOrigin = ${JSON.stringify(origin)};
if (window.opener && !window.opener.closed) {
  window.opener.postMessage(message, targetOrigin);
  window.close();
} else {
  const target = new URL(${JSON.stringify(returnTo)});
  target.hash = 'kakaoAuth=' + encodeURIComponent(JSON.stringify(message));
  window.location.replace(target.toString());
}
</script>
<p>${escapeHtml(body.ok ? "Kakao login completed." : "Kakao login failed.")}</p>
</body>
</html>`);
}

export default async function handler(req, res) {
  try {
    const code = String(req.query?.code || "").trim();
    const error = String(req.query?.error || "").trim();
    const state = verifyState(req.query?.state);

    if (error) {
      htmlResponse(res, 400, state, {
        ok: false,
        error,
        errorDescription: String(req.query?.error_description || ""),
      });
      return;
    }
    if (!code) throw new Error("Missing Kakao authorization code");

    const accessToken = await exchangeCodeForToken(req, code);
    const result = await createFirebaseTokenFromKakaoAccessToken(accessToken);
    htmlResponse(res, 200, state, {
      ok: true,
      ...result,
    });
  } catch (error) {
    htmlResponse(res, 500, null, {
      ok: false,
      error: error.message,
      details: error.details || null,
    });
  }
}

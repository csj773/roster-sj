import crypto from "crypto";

const DEFAULT_REPO = "csj773/roster-sj";
const DEFAULT_WORKFLOW_FILE = "update-roster.yml";
const DEFAULT_REF = "main";

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireApiKey(req) {
  const expected = process.env.ROSTER_API_KEY || process.env.API_KEY || "";
  if (!expected) return { ok: false, status: 500, error: "ROSTER_API_KEY is not configured" };
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

function clean(value) {
  return String(value || "").trim();
}

function workflowInputs(body) {
  const username = clean(body.username);
  const password = clean(body.password);
  const currentUserUid = clean(
    body.currentUserUid ||
      body.current_user_uid ||
      body.uid ||
      body.firebaseUid
  );
  const currentUserEmail = clean(
    body.currentUserEmail ||
      body.current_user_email ||
      body.email
  );

  if (!username || !password) {
    return { error: "username and password required" };
  }
  if (!currentUserUid) {
    return { error: "currentUserUid is required" };
  }

  return {
    inputs: {
      username,
      password,
      current_user_uid: currentUserUid,
      current_user_email: currentUserEmail,
    },
  };
}

async function dispatchWorkflow(inputs) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return { ok: false, status: 500, body: { error: "GITHUB_TOKEN is not configured" } };
  }

  const repo = process.env.GITHUB_REPO || DEFAULT_REPO;
  const workflowFile = process.env.GITHUB_WORKFLOW_FILE || DEFAULT_WORKFLOW_FILE;
  const ref = process.env.GITHUB_REF || DEFAULT_REF;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref, inputs }),
  });

  const text = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: {
        error: "GitHub workflow dispatch failed",
        details: text,
      },
    };
  }

  return {
    ok: true,
    status: 202,
    body: {
      ok: true,
      status: "queued",
      githubActionsUrl: `https://github.com/${repo}/actions/workflows/${workflowFile}`,
    },
  };
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
    const parsed = workflowInputs(body);
    if (parsed.error) {
      json(res, 400, { error: parsed.error });
      return;
    }

    const result = await dispatchWorkflow(parsed.inputs);
    json(res, result.status, result.body);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

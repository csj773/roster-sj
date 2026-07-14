const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const GITHUB_ACTIONS_TOKEN = defineSecret("GITHUB_ACTIONS_TOKEN");
const PERDIEM_TRIGGER_API_KEY = defineSecret("PERDIEM_TRIGGER_API_KEY");

const WORKFLOW_DISPATCH_URL =
  "https://api.github.com/repos/csj773/roster-sj/actions/workflows/monthly-perdiem-report.yml/dispatches";

function setCorsHeaders(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-api-key");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function normalizeOptionalInput(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function buildDispatchBody(body = {}) {
  const inputs = {};
  const targetMonth = normalizeOptionalInput(body.target_month ?? body.targetMonth);
  const targetYear = normalizeOptionalInput(body.target_year ?? body.targetYear);

  if (targetMonth) inputs.target_month = targetMonth;
  if (targetYear) inputs.target_year = targetYear;

  return {
    ref: normalizeOptionalInput(body.ref) || "main",
    ...(Object.keys(inputs).length ? { inputs } : {}),
  };
}

exports.runMonthlyPerdiemReport = onRequest(
  {
    region: "asia-northeast3",
    secrets: [GITHUB_ACTIONS_TOKEN, PERDIEM_TRIGGER_API_KEY],
    timeoutSeconds: 60,
  },
  async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const expectedApiKey = PERDIEM_TRIGGER_API_KEY.value();
    const providedApiKey = req.get("x-api-key") || "";
    if (!expectedApiKey || providedApiKey !== expectedApiKey) {
      res.status(401).json({ ok: false, error: "Unauthorized" });
      return;
    }

    const dispatchBody = buildDispatchBody(req.body);
    const response = await fetch(WORKFLOW_DISPATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_ACTIONS_TOKEN.value()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dispatchBody),
    });

    if (!response.ok) {
      const text = await response.text();
      res.status(response.status).json({
        ok: false,
        error: "GitHub workflow dispatch failed",
        detail: text,
      });
      return;
    }

    res.status(200).json({
      ok: true,
      workflow: "monthly-perdiem-report.yml",
      ref: dispatchBody.ref,
      inputs: dispatchBody.inputs || {},
    });
  }
);

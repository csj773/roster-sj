import {
  cleanText,
  db,
  json,
  setCors,
} from "./_shareUtils.mjs";

const INVITE_COLLECTION = "roster_share_invites";

function requestQuery(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `https://${host}`);
  return Object.fromEntries(url.searchParams.entries());
}

function serializeTime(value) {
  if (!value) return "";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return "";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const query = requestQuery(req);
    const code = cleanText(query.inviteCode || query.code || query.invite || "", 80);
    if (!code) {
      json(res, 400, { error: "inviteCode is required" });
      return;
    }

    const snap = await db().collection(INVITE_COLLECTION).doc(code).get();
    if (!snap.exists) {
      json(res, 404, { error: "Invite not found" });
      return;
    }

    const invite = snap.data();
    const expired = invite.expiresAt?.toDate && invite.expiresAt.toDate().getTime() < Date.now();
    json(res, 200, {
      ok: true,
      inviteCode: code,
      status: expired && invite.status === "open" ? "expired" : invite.status || "open",
      ownerDisplayName: invite.ownerDisplayName || "",
      scope: invite.scope || "layover_only",
      confirmationStatus: invite.confirmationStatus || "pending",
      confirmed: invite.confirmed === true || invite.confirmationStatus === "accepted",
      confirmedAt: serializeTime(invite.confirmedAt || invite.acceptedAt),
      useCount: invite.useCount || 0,
      maxUses: invite.maxUses || 1,
      expiresAt: serializeTime(invite.expiresAt),
    });
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message });
  }
}

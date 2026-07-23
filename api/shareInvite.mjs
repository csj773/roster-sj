import admin from "firebase-admin";
import {
  cleanText,
  db,
  inviteCode,
  json,
  nowTimestamp,
  publicUser,
  readJsonBody,
  requireFirebaseUser,
  setCors,
} from "./_lib/shareUtils.mjs";
import { sendRosterShareInviteEmail } from "./_lib/email.mjs";

const INVITE_COLLECTION = "roster_share_invites";

function appBaseUrl(req) {
  return (
    process.env.ROSTER_SHARE_APP_URL ||
    process.env.APP_BASE_URL ||
    `${String(req.headers["x-forwarded-proto"] || "https").split(",")[0]}://${req.headers.host}`
  ).replace(/\/+$/, "");
}

function inviteUrl(req, code) {
  const base = appBaseUrl(req);
  const path = process.env.ROSTER_SHARE_INVITE_PATH || "/roster-share";
  return `${base}${path}?invite=${encodeURIComponent(code)}`;
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
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
    const user = await requireFirebaseUser(req);
    const body = await readJsonBody(req);
    const scope = cleanText(body.scope || "layover_only", 40) || "layover_only";
    const note = cleanText(body.note || "", 500);
    const recipientEmail = cleanText(body.recipientEmail || body.email || body.toEmail || "", 240);
    const deliveryMethod = recipientEmail ? "email" : cleanText(body.deliveryMethod || "link", 40);
    const confirmationRequired = body.confirmationRequired !== false;
    const expiresInDays = Math.min(
      Math.max(Number.parseInt(body.expiresInDays || "14", 10) || 14, 1),
      90
    );
    const code = inviteCode();
    const owner = await publicUser(user.uid);
    const url = inviteUrl(req, code);
    const createdAt = nowTimestamp();
    const initialEmailStatus = recipientEmail ? "pending" : "not_required";

    await db().collection(INVITE_COLLECTION).doc(code).set({
      code,
      ownerUid: user.uid,
      ownerDisplayName: owner.displayName || user.name || "",
      ownerEmail: owner.email || user.email || "",
      recipientEmail,
      scope,
      note,
      status: "open",
      deliveryMethod,
      confirmationRequired,
      confirmationStatus: confirmationRequired ? "pending" : "not_required",
      confirmed: false,
      emailProvider: recipientEmail ? "resend" : "",
      emailStatus: initialEmailStatus,
      emailSent: false,
      maxUses: 1,
      useCount: 0,
      createdAt,
      updatedAt: createdAt,
      expiresAt: admin.firestore.Timestamp.fromDate(
        new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      ),
    });

    let emailResult = { sent: false, status: initialEmailStatus };
    if (recipientEmail) {
      emailResult = await sendRosterShareInviteEmail({
        to: recipientEmail,
        ownerName: owner.displayName || user.name || owner.email || user.email || "Roster Share",
        inviteUrl: url,
        scope,
        expiresInDays,
        confirmationRequired,
      });

      const emailUpdate = {
        emailStatus: emailResult.status,
        emailSent: emailResult.sent === true,
        emailProvider: "resend",
        updatedAt: nowTimestamp(),
      };
      if (emailResult.sent) {
        emailUpdate.emailSentAt = nowTimestamp();
        emailUpdate.resendEmailId = emailResult.id || "";
      }
      if (emailResult.error) {
        emailUpdate.emailError = emailResult.error;
      }

      await db().collection(INVITE_COLLECTION).doc(code).update(emailUpdate);
    }

    json(res, 201, {
      ok: true,
      inviteCode: code,
      inviteUrl: url,
      scope,
      deliveryMethod,
      confirmationRequired,
      confirmationStatus: confirmationRequired ? "pending" : "not_required",
      emailSent: emailResult.sent === true,
      emailStatus: emailResult.status,
      emailProvider: recipientEmail ? "resend" : "",
      resendEmailId: emailResult.id || "",
      expiresInDays,
    });
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message });
  }
}

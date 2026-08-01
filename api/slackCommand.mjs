import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import admin from "firebase-admin";
import { waitUntil } from "@vercel/functions";
import { generateAndRewriteSlackPerDiem } from "../scripts/slack_perdiem.js";
import {
  cleanDate,
  cleanText,
  db,
  inviteCode,
  json,
  nowTimestamp,
  publicUser,
  shareId,
} from "./_lib/shareUtils.mjs";

const INVITE_COLLECTION = "roster_share_invites";
const SHARE_COLLECTION = "roster_shares";
const ROSTER_COLLECTION = "roster";
const PDC_COLLECTION = "pdc";
const PDC_FLAT_MIRROR_COLLECTION = "PdcEvents";
const SHARE_ROSTER_COLLECTIONS = [ROSTER_COLLECTION, PDC_COLLECTION];
const SLACK_LINK_COLLECTION = "slack_user_links";
const SLACK_TEAM_OWNER_COLLECTION = "slack_team_roster_owners";
const SLACK_ICAL_SOURCE = "slack_ical";
const DEFAULT_GITHUB_REPO = "csj773/roster-sj";
const DEFAULT_GITHUB_REF = "main";
const ICAL_IMPORT_WORKFLOW_FILE = "import-ical-roster-to-pdc.yml";
const PERDIEM_SLACK_WORKFLOW_FILE = "monthly-perdiem-slack-report.yml";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ROSTER_HEADERS = ["Date", "DC", "C/I(L)", "C/O(L)", "Activity", "F", "From", "STD(L)", "STD(Z)", "To", "STA(L)", "STA(Z)", "BLH", "AcReg", "Crew"];
const FULL_MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function slackJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function queueSlackWork(work) {
  waitUntil(work.catch((error) => {
    console.error("Slack background work failed:", error);
  }));
}

async function postSlackResponse(responseUrl, body) {
  if (!responseUrl) return;
  const response = await fetch(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Slack response_url failed (${response.status})`);
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function uploadSlackCsv({ command, filename, title, csv, initialComment }) {
  const token = process.env.SLACK_BOT_TOKEN || "";
  const channelId = command.channelId || process.env.SLACK_CHANNEL_ID || "";
  if (!token || !channelId) {
    console.log("MY_ROSTER_CSV_UPLOAD_SKIPPED", {
      hasSlackBotToken: Boolean(token),
      channelId: channelId || "",
    });
    return false;
  }

  const file = Buffer.from(`\uFEFF${csv}`, "utf8");
  const urlResponse = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      filename,
      length: String(file.length),
    }),
  });
  const urlResult = await urlResponse.json();
  if (!urlResult.ok) {
    throw new Error(`Slack files.getUploadURLExternal failed: ${urlResult.error}`);
  }

  const binaryResponse = await fetch(urlResult.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  if (!binaryResponse.ok) {
    throw new Error(`Slack binary upload failed: HTTP ${binaryResponse.status}`);
  }

  const completeResponse = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: [{ id: urlResult.file_id, title }],
      channel_id: channelId,
      initial_comment: initialComment,
    }),
  });
  const completeResult = await completeResponse.json();
  if (!completeResult.ok) {
    throw new Error(`Slack files.completeUploadExternal failed: ${completeResult.error}`);
  }
  return true;
}

async function postCommandResult(command) {
  try {
    await postSlackResponse(command.responseUrl, await handleCommand(command));
  } catch (error) {
    await postSlackResponse(command.responseUrl, {
      response_type: "ephemeral",
      text: `Slack command failed for ${command.command || "command"}: ${error.message}`,
    });
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifySlackSignature(req, rawBody) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET || "";
  if (!signingSecret) {
    const error = new Error("SLACK_SIGNING_SECRET is not configured");
    error.statusCode = 500;
    throw error;
  }

  const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
  const signature = String(req.headers["x-slack-signature"] || "");
  const requestTime = Number.parseInt(timestamp, 10);
  if (!timestamp || !signature || Number.isNaN(requestTime)) {
    const error = new Error("Missing Slack signature headers");
    error.statusCode = 401;
    throw error;
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - requestTime) > 60 * 5) {
    const error = new Error("Stale Slack request");
    error.statusCode = 401;
    throw error;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex")}`;
  if (!timingSafeEqualText(signature, expected)) {
    const error = new Error("Invalid Slack signature");
    error.statusCode = 401;
    throw error;
  }
}

function parseSlashCommand(rawBody) {
  const params = new URLSearchParams(rawBody);
  return {
    command: cleanText(params.get("command"), 80),
    text: cleanText(params.get("text"), 500),
    teamId: cleanText(params.get("team_id"), 80),
    teamDomain: cleanText(params.get("team_domain"), 120),
    channelId: cleanText(params.get("channel_id"), 80),
    channelName: cleanText(params.get("channel_name"), 120),
    userId: cleanText(params.get("user_id"), 80),
    userName: cleanText(params.get("user_name"), 120),
    responseUrl: cleanText(params.get("response_url"), 500),
  };
}

function slackLinkId(teamId, userId) {
  return `${teamId}_${userId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function slackTeamOwnerId(teamId, ownerUid) {
  return `${teamId}_${ownerUid}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

async function saveSlackTeamRosterOwner(command, owner, source = "slack_import") {
  const teamId = cleanText(command.teamId || "", 80);
  const ownerUid = cleanText(owner?.uid || "", 160);

  if (!teamId || !ownerUid || ownerUid.startsWith("guest_")) return;

  await db()
    .collection(SLACK_TEAM_OWNER_COLLECTION)
    .doc(slackTeamOwnerId(teamId, ownerUid))
    .set({
      slackTeamId: teamId,
      ownerUid,
      uid: ownerUid,
      displayName: cleanText(owner.displayName || "", 200),
      email: cleanText(owner.email || "", 240).toLowerCase(),
      status: "active",
      source,
      updatedAt: nowTimestamp(),
      createdAt: nowTimestamp(),
    }, { merge: true });
}

async function slackLinkData(command) {
  const snap = await db()
    .collection(SLACK_LINK_COLLECTION)
    .doc(slackLinkId(command.teamId, command.userId))
    .get();
  return snap.exists ? snap.data() : null;
}

async function linkedFirebaseUid(command, { allowDefault = true } = {}) {
  const linkId = slackLinkId(command.teamId, command.userId);
  const data = await slackLinkData(command);

  if (data) {
    const linkedUid = cleanText(
      data.firebaseUid ||
      data.uid ||
      data.owner ||
      data.userId ||
      "",
      160
    );

    if (
      linkedUid &&
      data.status !== "disabled" &&
      !linkedUid.startsWith("guest_")
    ) {
      console.log("SLACK_USER_LINK_FOUND", {
        linkId,
        firebaseUid: linkedUid,
        source: data.source || "",
      });
      return linkedUid;
    }

    console.warn("SLACK_USER_LINK_INVALID", {
      linkId,
      linkedUid,
      status: data.status || "",
    });
  }

  if (!allowDefault) return "";

  const configuredUid = cleanText(
    process.env.SLACK_DEFAULT_FIREBASE_UID || "",
    160
  );

  console.warn("SLACK_USER_LINK_FALLBACK", {
    linkId,
    firebaseUid: configuredUid,
  });

  return configuredUid;
}

async function linkSlackUserToDefaultUid(command) {
  const firebaseUid = cleanText(process.env.SLACK_DEFAULT_FIREBASE_UID || "", 160);
  if (!firebaseUid) {
    throw new Error("SLACK_DEFAULT_FIREBASE_UID is not configured");
  }

  const owner = await publicUser(firebaseUid);
  const linkId = slackLinkId(command.teamId, command.userId);
  await db().collection(SLACK_LINK_COLLECTION).doc(linkId).set({
    firebaseUid,
    uid: firebaseUid,
    owner: firebaseUid,
    slackTeamId: command.teamId,
    slackTeamDomain: command.teamDomain || "",
    slackUserId: command.userId,
    slackUserName: command.userName || "",
    firebaseDisplayName: owner.displayName || "",
    firebaseEmail: owner.email || "",
    status: "active",
    source: "slack_link_me",
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  }, { merge: true });

  await saveSlackTeamRosterOwner(command, {
    uid: firebaseUid,
    displayName: owner.displayName || "",
    email: owner.email || "",
  }, "slack_link_me");

  return {
    linkId,
    firebaseUid,
    owner,
  };
}

function guestEmailUid(email) {
  return `guest_email_${cleanText(email, 240).toLowerCase()}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function emailRosterOwnerUid(email) {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  if (!normalizedEmail) return "";
  return `email_owner_${hashText(normalizedEmail).slice(0, 28)}`;
}

function guestInviteUid(inviteCodeValue) {
  return `guest_${cleanText(inviteCodeValue, 80)}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function displayNameForEmail(email) {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  const displayNames = {
    "cutecsj773@gmail.com": "최상준",
  };
  return displayNames[normalizedEmail] || "";
}

async function acceptedInviteForEmail(email) {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  if (!normalizedEmail) return null;

  const snap = await db()
    .collection(INVITE_COLLECTION)
    .where("recipientEmail", "==", normalizedEmail)
    .limit(10)
    .get();

  const accepted = snap.docs
    .map((doc) => ({ code: doc.id, ...doc.data() }))
    .filter((invite) => invite.confirmed === true || invite.confirmationStatus === "accepted")
    .sort((a, b) => {
      const left = a.acceptedAt?.toMillis?.() || a.confirmedAt?.toMillis?.() || 0;
      const right = b.acceptedAt?.toMillis?.() || b.confirmedAt?.toMillis?.() || 0;
      return right - left;
    });

  return accepted[0] || null;
}

async function firebaseOwnerByEmail(email, requestedDisplayName = "") {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  if (!normalizedEmail) throw new Error("Email is required");

  // 1. Try Firebase Authentication only when an Admin app is available.
  try {
    if (admin.apps?.length) {
      const userRecord = await admin.auth().getUserByEmail(normalizedEmail);
      return {
        uid: userRecord.uid,
        email: cleanText(userRecord.email || normalizedEmail, 240).toLowerCase(),
        displayName:
          cleanText(userRecord.displayName || "", 200) ||
          cleanText(requestedDisplayName, 200) ||
          displayNameForEmail(normalizedEmail) ||
          normalizedEmail,
        source: "firebase_auth_email",
      };
    }

    console.warn("FIREBASE_AUTH_LOOKUP_SKIPPED", {
      email: normalizedEmail,
      reason: "admin_app_not_initialized",
    });
  } catch (error) {
    if (
      error.code !== "auth/user-not-found" &&
      error.code !== "app/no-app"
    ) {
      console.warn("FIREBASE_AUTH_EMAIL_LOOKUP_FAILED", {
        email: normalizedEmail,
        code: error.code || "",
        message: error.message || "",
      });
    }
  }

  // 2. Look for the owner document in the migrated PDC structure.
  const pdcOwnerSnapshot = await db()
    .collection(PDC_COLLECTION)
    .where("email", "==", normalizedEmail)
    .limit(1)
    .get();

  if (!pdcOwnerSnapshot.empty) {
    const doc = pdcOwnerSnapshot.docs[0];
    const data = doc.data() || {};
    const uid = cleanText(
      data.owner || data.uid || doc.id || "",
      160
    );

    if (uid && !uid.startsWith("guest_")) {
      return {
        uid,
        email: normalizedEmail,
        displayName:
          cleanText(
            data.display_name ||
            data.pdc_user_name ||
            requestedDisplayName ||
            normalizedEmail,
            200
          ),
        source: "pdc_owner_email",
      };
    }
  }

  // 3. Look for a matching public users document.
  const usersSnapshot = await db()
    .collection("users")
    .where("email", "==", normalizedEmail)
    .limit(1)
    .get();

  if (!usersSnapshot.empty) {
    const doc = usersSnapshot.docs[0];
    const data = doc.data() || {};
    const uid = cleanText(data.uid || doc.id || "", 160);

    if (uid && !uid.startsWith("guest_")) {
      return {
        uid,
        email: normalizedEmail,
        displayName:
          cleanText(
            data.displayName ||
            data.display_name ||
            requestedDisplayName ||
            normalizedEmail,
            200
          ),
        source: "firestore_user_email",
      };
    }
  }

  return null;
}

async function resolveImportOwnerForEmail(command, email) {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  if (!normalizedEmail) throw new Error("Roster owner email is required");

  const requestedDisplayName =
    displayNameForEmail(normalizedEmail) ||
    normalizedEmail ||
    command.userName ||
    "Roster user";

  let owner = await firebaseOwnerByEmail(normalizedEmail, requestedDisplayName);

  if (!owner) {
    const invite = await acceptedInviteForEmail(normalizedEmail);
    const acceptedUid = cleanText(invite?.acceptedByUid || "", 160);

    if (acceptedUid && !acceptedUid.startsWith("guest_")) {
      const acceptedUser = await publicUser(acceptedUid);
      owner = {
        uid: acceptedUid,
        email: cleanText(
          acceptedUser?.email || normalizedEmail,
          240
        ).toLowerCase(),
        displayName:
          cleanText(acceptedUser?.displayName || "", 200) ||
          requestedDisplayName,
        source: "accepted_invite",
        inviteCode: invite?.code || "",
      };
    }
  }

  if (!owner) {
    const defaultUid = cleanText(
      process.env.SLACK_DEFAULT_FIREBASE_UID || "",
      160
    );
    const defaultUser = defaultUid ? await publicUser(defaultUid) : {};
    const defaultEmail = cleanText(defaultUser?.email || "", 240).toLowerCase();

    // Use the configured Firebase UID only for the matching account.
    // Other imported emails receive a stable per-email roster owner UID so
    // multiple users do not collapse into one owner.
    if (defaultUid && defaultEmail && defaultEmail === normalizedEmail) {
      owner = {
        uid: defaultUid,
        email: normalizedEmail,
        displayName:
          cleanText(defaultUser?.displayName || "", 200) ||
          requestedDisplayName,
        source: "default_firebase_uid_matching_email",
      };
    } else {
      owner = {
        uid: emailRosterOwnerUid(normalizedEmail),
        email: normalizedEmail,
        displayName: requestedDisplayName,
        source: "stable_email_roster_owner",
      };
    }
  }

  if (!owner.uid || owner.uid.startsWith("guest_")) {
    throw new Error(
      `Invalid Firebase owner UID resolved: ${owner.uid || "(empty)"}`
    );
  }

  const linkId = slackLinkId(command.teamId, command.userId);

  await db().collection(SLACK_LINK_COLLECTION).doc(linkId).set({
    firebaseUid: owner.uid,
    uid: owner.uid,
    owner: owner.uid,
    slackTeamId: command.teamId,
    slackTeamDomain: command.teamDomain || "",
    slackUserId: command.userId,
    slackUserName: command.userName || "",
    recipientEmail: normalizedEmail,
    firebaseEmail: owner.email || normalizedEmail,
    firebaseDisplayName: owner.displayName || requestedDisplayName,
    status: "active",
    source: owner.source || "slack_import_email",
    inviteCode: owner.inviteCode || "",
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  }, { merge: true });

  await saveSlackTeamRosterOwner(command, {
    uid: owner.uid,
    displayName: owner.displayName || requestedDisplayName,
    email: owner.email || normalizedEmail,
  }, owner.source || "slack_import_email");

  console.log("SLACK_IMPORT_OWNER_RESOLVED", {
    linkId,
    email: normalizedEmail,
    firebaseUid: owner.uid,
    source: owner.source,
    pdcPath: `${PDC_COLLECTION}/${ownerPdcDocId(owner.uid)}/events`,
  });

  return {
    firebaseUid: owner.uid,
    owner: {
      uid: owner.uid,
      displayName: owner.displayName || requestedDisplayName,
      email: owner.email || normalizedEmail,
    },
    linkId,
    inviteCode: owner.inviteCode || "",
  };
}

function shareDocData({ owner, sharedWith, scope = "layover_only", source = "slack_email_import_auto_share" }) {
  return {
    ownerUid: owner.uid,
    ownerDisplayName: owner.displayName || "",
    ownerEmail: owner.email || "",
    sharedWithUid: sharedWith.uid,
    sharedWithDisplayName: sharedWith.displayName || "",
    sharedWithEmail: sharedWith.email || "",
    scope,
    status: "active",
    confirmationStatus: "accepted",
    confirmed: true,
    source,
    confirmedByUid: sharedWith.uid,
    confirmedAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  };
}

async function slackTeamParticipantOwners(command) {
  if (!command.teamId) return [];
  const snap = await db()
    .collection(SLACK_LINK_COLLECTION)
    .where("slackTeamId", "==", command.teamId)
    .get();

  const owners = new Map();
  for (const doc of snap.docs) {
    const link = doc.data();
    if (link.status === "disabled") continue;
    const uid = cleanText(link.firebaseUid || link.uid || "", 160);
    if (!uid) continue;
    owners.set(uid, {
      uid,
      displayName: link.firebaseDisplayName || link.recipientEmail || link.firebaseEmail || link.slackUserName || uid,
      email: link.recipientEmail || link.firebaseEmail || "",
    });
  }
  return [...owners.values()];
}

async function autoShareOwnerWithSlackTeam(command, owner) {
  const participants = (await slackTeamParticipantOwners(command)).filter((participant) => participant.uid !== owner.uid);
  const ownerVariants = [
    owner,
    ...(owner.email ? [{ ...owner, uid: owner.email, displayName: owner.displayName || owner.email }] : []),
  ];
  let writeCount = 0;
  for (let i = 0; i < participants.length; i += 200) {
    const batch = db().batch();
    for (const ownerVariant of ownerVariants) {
      for (const participant of participants.slice(i, i + 200)) {
        if (participant.uid === ownerVariant.uid) continue;
        batch.set(
          db().collection(SHARE_COLLECTION).doc(shareId(ownerVariant.uid, participant.uid)),
          shareDocData({ owner: ownerVariant, sharedWith: participant }),
          { merge: true }
        );
        batch.set(
          db().collection(SHARE_COLLECTION).doc(shareId(participant.uid, ownerVariant.uid)),
          shareDocData({ owner: participant, sharedWith: ownerVariant }),
          { merge: true }
        );
        writeCount += 1;
      }
    }
    await batch.commit();
  }
  return writeCount;
}

function appBaseUrl() {
  return String(
    process.env.ROSTER_SHARE_APP_URL ||
      process.env.APP_BASE_URL ||
      "https://roster-sj-j3bu.vercel.app"
  ).replace(/\/+$/, "");
}

function inviteUrl(code) {
  const path = process.env.ROSTER_SHARE_INVITE_PATH || "/roster-share";
  return `${appBaseUrl()}${path}?invite=${encodeURIComponent(code)}`;
}

function slackRosterGuideUrl() {
  const path = process.env.SLACK_ROSTER_GUIDE_PATH || "/slack-roster-guide/";
  return `${appBaseUrl()}${path}`;
}

function slackChannelUrl(command) {
  if (!command.teamId || !command.channelId) return "";
  return `https://app.slack.com/client/${encodeURIComponent(command.teamId)}/${encodeURIComponent(command.channelId)}`;
}

function mailInviteUrl({ inviteUrl: url, ownerName = "", recipientEmail = "", channelUrl = "" }) {
  const owner = cleanText(ownerName || "Roster Share", 120);
  const subject = "Roster Share 참여 링크";
  const statusUrl = `${url}${url.includes("?") ? "&" : "?"}mode=status`;
  const body = [
    url,
    "",
    statusUrl,
    ...(channelUrl ? ["", channelUrl] : []),
    "",
    `${owner} 님이 Roster Share에 초대했습니다.`,
    "",
    "첫 번째 URL: 수락하기",
    "두 번째 URL: 수락 여부 확인",
    ...(channelUrl ? ["세 번째 URL: Slack 채널 참여"] : []),
    "",
    "[주의]",
    "수락하면 같은 Roster Share 채널 참여자들과 layover roster 공유가 자동 연결됩니다.",
    `사용 전 가이드: ${slackRosterGuideUrl()}`,
    `본인 roster를 공유하려면 Slack 채널에서 /roster-share import ${recipientEmail || "본인이메일@example.com"} webcal://... 를 실행해 주세요.`,
    "공유 조회는 채널에서 /layover IAD 처럼 실행합니다.",
    "",
    "메일 앱에서 URL이 클릭되지 않으면 첫 번째 URL을 복사해서 브라우저 주소창에 붙여넣어 주세요.",
  ].join("\n");
  const params = new URLSearchParams({
    subject,
    body,
  });
  const recipient = cleanText(recipientEmail, 240);
  if (recipient) params.set("to", recipient);
  return `${appBaseUrl()}/api/mailInvite?${params.toString()}`;
}

function inviteShareText(url, channelUrl = "") {
  const statusUrl = `${url}${url.includes("?") ? "&" : "?"}mode=status`;
  return [
    url,
    "",
    statusUrl,
    ...(channelUrl ? ["", channelUrl] : []),
    "",
    "첫 번째 URL: 수락하기",
    "두 번째 URL: 수락 여부 확인",
    ...(channelUrl ? ["세 번째 URL: Slack 채널 참여"] : []),
    "",
    "[주의]",
    "수락하면 같은 Roster Share 채널 참여자들과 layover roster 공유가 자동 연결됩니다.",
    `사용 전 가이드: ${slackRosterGuideUrl()}`,
    "본인 roster 공유: /roster-share import 본인이메일@example.com webcal://...",
    "공유 조회: /layover IAD",
  ].join("\n");
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value, 240));
}

function importEmailArg(commandText) {
  const args = parseSlackArgs(commandText);
  const action = cleanText(args[0] || "", 40).toLowerCase();
  const startIndex = ["import", "sync", "link", "ical", "webcal"].includes(action) ? 1 : 0;
  return cleanText(args.slice(startIndex).find((arg) => looksLikeEmail(arg)) || "", 240).toLowerCase();
}

async function dispatchIcalImportWorkflow({ calendarUrl, firebaseUid, owner }) {
  const token = process.env.GITHUB_TOKEN || "";
  if (!token) return { dispatched: false };
  if (!calendarUrl) {
    throw new Error("Slack iCal import requires the user's personal iCal URL.");
  }

  const repo = process.env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const ref = process.env.GITHUB_REF || DEFAULT_GITHUB_REF;
  const workflowFile = process.env.GITHUB_ICAL_IMPORT_WORKFLOW_FILE || ICAL_IMPORT_WORKFLOW_FILE;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        ical_roster_url: calendarUrl,
        current_user_uid: firebaseUid,
        current_user_email: owner.email || "",
        pdc_user_name: owner.displayName || "",
        import_source: "slack",
      },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub iCal import workflow dispatch failed (${response.status}): ${text}`);
  }

  return {
    dispatched: true,
    actionsUrl: `https://github.com/${repo}/actions/workflows/${workflowFile}`,
  };
}

function parsePerDiemReportText(text) {
  const parts = parseSlackArgs(text);
  const action = cleanText(parts[0] || "", 40).toLowerCase();
  let targetMonth = "";
  let targetYear = "";
  let reportEmail = "";

  for (const part of parts) {
    const normalizedPart = cleanText(part, 20).toLowerCase();
    if (looksLikeEmail(part)) {
      reportEmail = cleanText(part, 240).toLowerCase();
      continue;
    }
    const yearMonth = part.match(/^(\d{4})[-/.](\d{1,2})$/);
    if (yearMonth) {
      targetYear = yearMonth[1];
      targetMonth = yearMonth[2];
      continue;
    }
    if (/^\d{4}$/.test(part)) {
      targetYear = part;
    } else if (/^\d{1,2}$/.test(part)) {
      targetMonth = part;
    } else {
      const monthIndex = MONTH_NAMES.findIndex((month) => month.toLowerCase() === normalizedPart);
      const fullMonthIndex = FULL_MONTH_NAMES.indexOf(normalizedPart);
      const resolvedIndex = monthIndex >= 0 ? monthIndex : fullMonthIndex;
      if (resolvedIndex >= 0) targetMonth = String(resolvedIndex + 1);
    }
  }

  return { action, targetMonth, targetYear, reportEmail };
}

function perDiemMonthHint({ targetMonth, targetYear }) {
  if (!targetMonth) return "default month";
  const monthNumber = Number(targetMonth);
  const monthName = MONTH_NAMES[monthNumber - 1] || String(targetMonth);
  return targetYear ? `${monthName} ${targetYear}` : monthName;
}

async function dispatchPerDiemSlackWorkflow({ command, firebaseUid, owner, reportEmail = "", targetMonth, targetYear }) {
  const token = process.env.GITHUB_TOKEN || "";
  if (!token) return { dispatched: false };

  const repo = process.env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const ref = process.env.GITHUB_REF || DEFAULT_GITHUB_REF;
  const workflowFile = process.env.GITHUB_PERDIEM_SLACK_WORKFLOW_FILE || PERDIEM_SLACK_WORKFLOW_FILE;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`;
  const ownerEmail = cleanText(owner.email || reportEmail || "", 240).toLowerCase();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref,
      inputs: {
        current_user_email: ownerEmail,
        current_user_uid: firebaseUid,
        current_user_name: owner.displayName || ownerEmail || command.userName || "",
        target_month: targetMonth || "",
        target_year: targetYear || "",
        slack_response_url: command.responseUrl || "",
      },
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub PerDiem Slack workflow dispatch failed (${response.status}): ${responseText}`);
  }

  return {
    dispatched: true,
    actionsUrl: `https://github.com/${repo}/actions/workflows/${workflowFile}`,
  };
}

async function pdcOwnerForEmail(email) {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  if (!normalizedEmail) return null;

  const pdcByEmail = await db()
    .collection(PDC_COLLECTION)
    .where("email", "==", normalizedEmail)
    .limit(1)
    .get();
  if (!pdcByEmail.empty) {
    const data = pdcByEmail.docs[0].data();
    const uid = cleanText(data.owner || data.uid || "", 160);
    if (uid) {
      return {
        firebaseUid: uid,
        owner: {
          uid,
          displayName: data.display_name || data.pdc_user_name || displayNameForEmail(normalizedEmail) || normalizedEmail,
          email: normalizedEmail,
        },
      };
    }
  }

  const usersByEmail = await db()
    .collection("users")
    .where("email", "==", normalizedEmail)
    .limit(1)
    .get();
  const userUid = usersByEmail.empty ? "" : usersByEmail.docs[0].id;
  const candidates = [
    cleanText(usersByEmail.docs[0]?.data()?.uid || userUid || "", 160),
    normalizedEmail,
  ].filter(Boolean);

  for (const uid of candidates) {
    const pdcByOwner = await db()
      .collection(PDC_COLLECTION)
      .where("owner", "==", uid)
      .limit(1)
      .get();
    if (!pdcByOwner.empty) {
      const owner = await publicUser(uid);
      return {
        firebaseUid: uid,
        owner: {
          uid,
          displayName: owner.displayName || displayNameForEmail(normalizedEmail) || normalizedEmail,
          email: owner.email || normalizedEmail,
        },
      };
    }
  }

  return null;
}

async function setPerDiemReportEmail(command, email) {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  const resolved = await pdcOwnerForEmail(normalizedEmail);
  if (!resolved) {
    return {
      response_type: "ephemeral",
      text: `No pdc roster owner found for \`${normalizedEmail}\`. Run roster import for that email first, then retry \`/perdiem-report set-email ${normalizedEmail}\`.`,
    };
  }

  const linkId = slackLinkId(command.teamId, command.userId);
  await db().collection(SLACK_LINK_COLLECTION).doc(linkId).set({
    slackTeamId: command.teamId,
    slackTeamDomain: command.teamDomain || "",
    slackUserId: command.userId,
    slackUserName: command.userName || "",
    perdiemReportEmail: normalizedEmail,
    perdiemReportUid: resolved.firebaseUid,
    perdiemReportDisplayName: resolved.owner.displayName || normalizedEmail,
    status: "active",
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  }, { merge: true });

  return {
    response_type: "ephemeral",
    text: [
      "PerDiem report owner email saved.",
      `Email: \`${normalizedEmail}\``,
      `Owner: \`${resolved.owner.displayName || resolved.owner.email || resolved.firebaseUid}\``,
      "Next: `/perdiem-report jul` or `/perdiem-report user@example.com jul`",
    ].join("\n"),
  };
}

async function createInviteForUid(uid, { scope = "layover_only", note = "" } = {}) {
  const code = inviteCode();
  const owner = await publicUser(uid);
  await db().collection(INVITE_COLLECTION).doc(code).set({
    code,
    ownerUid: uid,
    ownerDisplayName: owner.displayName || "",
    ownerEmail: owner.email || "",
    scope,
    note,
    status: "open",
    maxUses: 1,
    useCount: 0,
    source: "slack",
    createdAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(
      new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    ),
  });
  return {
    inviteCode: code,
    inviteUrl: inviteUrl(code),
    owner,
  };
}

function addDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todaySeoul() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function upper(value) {
  return cleanText(value, 20).toUpperCase();
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

const PDC_HASH_SKIP_FIELDS = new Set([
  "createdAt",
  "importedAt",
  "rewrittenAt",
  "updatedAt",
  "sourceHash",
  "sourceHashUpdatedAt",
]);

function stableHashValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableHashValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => !PDC_HASH_SKIP_FIELDS.has(key))
      .sort()
      .map((key) => [key, stableHashValue(value[key])]));
  }
  return value;
}

function sourceHashForDocEntries(entries) {
  const stableEntries = entries
    .map(({ id, data }) => ({ id, data: stableHashValue(data) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return hashText(JSON.stringify(stableEntries));
}

function ownerPdcDocId(ownerUid) {
  return cleanText(ownerUid, 500).replace(/\//g, "_") || "unknown_owner";
}

function pdcEventDocId(docData) {
  return hashText([
    docData.owner,
    docData.Date,
    docData.DC,
    docData.Activity,
    docData.From,
    docData.To,
  ].join("|"));
}

function crewKey(value) {
  const crewArray = Array.isArray(value?.CrewArray)
    ? value.CrewArray
    : Array.isArray(value?.crewArray)
      ? value.crewArray
      : [];
  return crewArray.map((name) => cleanText(name, 40)).filter(Boolean).sort().join(",");
}

function importedRosterDuplicateKey(docData) {
  return [
    docData.owner,
    docData.Activity,
    docData.From,
    docData.To,
    crewKey(docData),
  ].join("|");
}

function dayNumber(value) {
  const key = dateSortKey(value);
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000;
}

function timeMinutes(value) {
  const match = cleanText(value, 40).match(/(\d{1,2}):?(\d{2})/);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function looksLikeSameImportedRosterEvent(a, b) {
  if (importedRosterDuplicateKey(a) !== importedRosterDuplicateKey(b)) return false;
  const dayDiff = Math.abs(dayNumber(a.Date) - dayNumber(b.Date));
  if (dayDiff === 0) return true;
  if (dayDiff !== 1) return false;

  const aTime = timeMinutes(a.STDL || a["STD(L)"] || a.STDZ || a.STD);
  const bTime = timeMinutes(b.STDL || b["STD(L)"] || b.STDZ || b.STD);
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return false;
  return Math.max(aTime, bTime) >= 20 * 60 && Math.min(aTime, bTime) <= 4 * 60;
}

function preferredRosterDoc(current, candidate) {
  if (!current) return candidate;
  const currentDateTime = `${dateSortKey(current.Date)} ${cleanText(current.STDL || current["STD(L)"] || current.STDZ || current.STD, 40)}`;
  const candidateDateTime = `${dateSortKey(candidate.Date)} ${cleanText(candidate.STDL || candidate["STD(L)"] || candidate.STDZ || candidate.STD, 40)}`;
  return candidateDateTime >= currentDateTime ? candidate : current;
}

function dedupeImportedRosterDocs(docs) {
  const groups = [];
  for (const docData of docs) {
    const group = groups.find((items) => looksLikeSameImportedRosterEvent(items[0], docData));
    if (group) {
      group.push(docData);
    } else {
      groups.push([docData]);
    }
  }
  return groups.map((items) => items.reduce(preferredRosterDoc, null));
}

async function deleteExistingOwnerPdcDocs(docs) {
  const owner = cleanText(docs[0]?.owner, 500);
  if (!owner) return 0;

  const refs = new Map();
  const flatSnapshot = await db().collection(PDC_COLLECTION).where("owner", "==", owner).get();
  for (const doc of flatSnapshot.docs) {
    refs.set(doc.ref.path, doc.ref);
  }

  const mirrorSnapshot = await db().collection(PDC_FLAT_MIRROR_COLLECTION).where("owner", "==", owner).get();
  for (const doc of mirrorSnapshot.docs) {
    refs.set(doc.ref.path, doc.ref);
  }

  const eventsSnapshot = await db()
    .collection(PDC_COLLECTION)
    .doc(ownerPdcDocId(owner))
    .collection("events")
    .get();
  for (const doc of eventsSnapshot.docs) {
    refs.set(doc.ref.path, doc.ref);
  }

  const csvRowsSnapshot = await db()
    .collection(PDC_COLLECTION)
    .doc(ownerPdcDocId(owner))
    .collection("csvRows")
    .get();
  for (const doc of csvRowsSnapshot.docs) {
    refs.set(doc.ref.path, doc.ref);
  }

  for (const ref of refs.values()) {
    await ref.delete();
  }
  return refs.size;
}

function parseSlackArgs(text) {
  return cleanText(text, 500).split(/\s+/).filter(Boolean);
}

function extractRosterCalendarUrl(text) {
  const raw = cleanText(text, 500);
  const slackLink = raw.match(/<(webcal:\/\/[^>|]+|https:\/\/[^>|]+)(?:\|[^>]+)?>/i);
  const plain = raw.match(/(?:webcal|https):\/\/\S+/i);
  return cleanText(slackLink?.[1] || plain?.[0] || "", 500);
}

function fetchableCalendarUrl(value) {
  const text = cleanText(value, 500).replace(/^\*+|[*>.,;)\]]+$/g, "");
  if (/^webcal:\/\//i.test(text)) return `https://${text.slice("webcal://".length)}`;
  if (/^https:\/\//i.test(text)) return text;
  return "";
}

function unfoldIcsLines(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function decodeIcsText(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseIcsValue(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const keyPart = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = keyPart.split(";");
  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

function parseIcsEvents(text) {
  const events = [];
  let current = null;
  for (const line of unfoldIcsLines(text)) {
    if (line.trim() === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line.trim() === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseIcsValue(line);
    if (!parsed) continue;
    current[parsed.name] = {
      params: parsed.params,
      value: decodeIcsText(parsed.value),
    };
  }
  return events;
}

function parseIcsDate(value) {
  const text = cleanText(value, 40);
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!match) return { date: "", time: "" };
  const iso = match[4]
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`
    : `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
  return {
    date: `${match[1]}.${match[2]}.${match[3]}`,
    time: match[4] ? `${match[4]}:${match[5]}` : "",
    iso,
  };
}

function minutesFromColonTime(value) {
  const match = cleanText(value, 20).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function timeWithDateOffset(start, end) {
  if (!end.time) return "";
  const startMinutes = minutesFromColonTime(start.time);
  const endMinutes = minutesFromColonTime(end.time);
  const dayOffset = start.date && end.date
    ? Math.round((Date.parse(end.date.replace(/\./g, "-")) - Date.parse(start.date.replace(/\./g, "-"))) / 86400000)
    : 0;
  if (dayOffset > 0) return `${end.time}+${dayOffset}`;
  if (dayOffset < 0) return `${end.time}${dayOffset}`;
  return startMinutes !== null && endMinutes !== null && endMinutes <= startMinutes
    ? `${end.time}+1`
    : end.time;
}

function compactTimeWithOffset(value) {
  const match = cleanText(value, 40).match(/^(\d{1,2}):(\d{2})([+-]\d+)?$/);
  if (!match) return cleanText(value, 40);
  return `${match[1].padStart(2, "0")}${match[2]}${match[3] || ""}`;
}

function extractedTime(text, kind, zone) {
  const source = cleanText(text, 2000);
  const pattern = new RegExp(`${kind}\\\\s*(?:\\\\(${zone}\\\\)|${zone})?[^0-9+-]{0,12}(\\\\d{1,2}:?\\\\d{2}(?:[+-]\\\\d+)?)`, "i");
  const match = source.match(pattern);
  return match ? compactTimeWithOffset(match[1]) : "";
}

function comparePerDiemTimes(left, right) {
  const a = compactTimeWithOffset(left).match(/^(\d{2})(\d{2})/);
  const b = compactTimeWithOffset(right).match(/^(\d{2})(\d{2})/);
  if (!a || !b) return null;
  return (Number(a[1]) * 60 + Number(a[2])) - (Number(b[1]) * 60 + Number(b[2]));
}

function arrivalWithOffset(std, sta) {
  const arrival = compactTimeWithOffset(sta);
  if (!arrival || /[+-]\d+$/.test(arrival)) return arrival;
  const comparison = comparePerDiemTimes(arrival, std);
  return comparison !== null && comparison <= 0 ? `${arrival}+1` : arrival;
}

function perDiemMarkers(route, end) {
  const from = cleanText(route.from, 10).toUpperCase();
  const to = cleanText(route.to, 10).toUpperCase();
  const arrivalIso = end.iso || "";
  return {
    RI: from === "ICN" && to && to !== "ICN" ? arrivalIso : "",
    RO: to === "ICN" && from && from !== "ICN" ? arrivalIso : "",
  };
}

function dateSortKey(value) {
  const match = String(value || "").match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/);
  if (!match) return cleanText(value, 20);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function monthName(month) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] || "";
}

function firstRoute(text) {
  const normalized = cleanText(text, 1000).toUpperCase();
  const match = normalized.match(/\b([A-Z]{3})\s*(?:-|–|—|→|>|TO)\s*([A-Z]{3})\b/);
  return {
    from: match?.[1] || "",
    to: match?.[2] || "",
  };
}

function activityFromIcs(summary, description) {
  const text = `${summary} ${description}`;
  const flight = text.match(/\b[A-Z]{2}\s?\d{2,4}[A-Z]?\b/);
  return cleanText((flight?.[0] || summary || "ROSTER").replace(/\s+/g, ""), 80);
}

function crewFromIcsDescription(description) {
  const lines = String(description || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const crewLines = lines
    .filter((line) => /,/u.test(line))
    .filter((line) => /\p{Script=Hangul}/u.test(line));
  const crew = cleanText(crewLines.join("\n"), 1000);
  const crewArray = [];
  for (const line of crewLines) {
    const match = line.match(/([\p{Script=Hangul}]{2,4})\s*,/u);
    if (match && !crewArray.includes(match[1])) crewArray.push(match[1]);
  }
  return { crew, crewArray };
}

function icsEventToRosterDoc(event, owner) {
  const summary = cleanText(event.SUMMARY?.value || "", 200);
  const description = cleanText(event.DESCRIPTION?.value || "", 1000);
  const location = cleanText(event.LOCATION?.value || "", 200);
  const text = `${summary}\n${description}\n${location}`;
  const start = parseIcsDate(event.DTSTART?.value || "");
  const end = parseIcsDate(event.DTEND?.value || "");
  const endTime = timeWithDateOffset(start, end);
  const route = firstRoute(text);
  const activity = activityFromIcs(summary, description);
  if (!start.date || !activity) return null;
  const stdl = extractedTime(text, "STD", "L") || start.time;
  const stal = extractedTime(text, "STA", "L") || endTime;
  const startCompact = extractedTime(text, "STD", "Z") || compactTimeWithOffset(start.time);
  const endCompact = arrivalWithOffset(startCompact, extractedTime(text, "STA", "Z") || endTime);

  const uid = cleanText(event.UID?.value || hashText(`${summary}_${description}_${start.date}_${start.time}`), 200);
  const year = start.date.slice(0, 4);
  const month = Number.parseInt(start.date.slice(5, 7), 10);
  const { crew, crewArray } = crewFromIcsDescription(description);
  const markers = perDiemMarkers(route, end);

  return {
    owner: owner.uid,
    uid: owner.uid,
    Date: start.date,
    DateRaw: start.date,
    Activity: activity,
    From: route.from,
    To: route.to,
    STD: start.iso || "",
    STA: end.iso || "",
    STDL: stdl,
    STAL: stal,
    STDZ: startCompact,
    STAZ: endCompact,
    "STD(L)": stdl,
    "STA(L)": stal,
    "STD(Z)": startCompact,
    "STA(Z)": endCompact,
    RI: markers.RI,
    RO: markers.RO,
    CIL: "",
    COL: "",
    DC: "",
    F: activity,
    Crew: crew,
    CrewArray: crewArray,
    ET: "00:00",
    NT: "00:00",
    BLH: "",
    Year: year,
    Month: monthName(month),
    pdc_user_name: owner.displayName || "",
    display_name: owner.displayName || "",
    email: owner.email || "",
    source: SLACK_ICAL_SOURCE,
    sourceUidHash: hashText(uid),
    sourceSummary: summary,
    sourceDescription: description,
    sourceLocation: location,
    importedAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
  };
}

async function fetchIcsCalendar(calendarUrl) {
  const url = fetchableCalendarUrl(calendarUrl);
  if (!url) throw new Error("webcal:// or https:// iCal URL is required");
  const response = await fetch(url, {
    headers: {
      Accept: "text/calendar, text/plain, */*",
      "User-Agent": "roster-sj-slack-bot/1.0",
    },
  });
  if (!response.ok) throw new Error(`iCal fetch failed (${response.status})`);
  const text = await response.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("Response is not an iCal calendar");
  return text;
}

async function uploadImportedRosterToPdc(docs) {
  const uniqueDocs = dedupeImportedRosterDocs(docs);
  const owner = cleanText(uniqueDocs[0]?.owner, 500);
  const ownerRef = db().collection(PDC_COLLECTION).doc(ownerPdcDocId(owner));
  const docEntries = uniqueDocs.map((docData) => ({
    id: pdcEventDocId(docData),
    data: docData,
  }));
  const sourceHash = sourceHashForDocEntries(docEntries);
  const ownerSnapshot = await ownerRef.get();
  if (ownerSnapshot.exists && ownerSnapshot.get("sourceHash") === sourceHash) {
    return {
      deleted: 0,
      imported: docEntries.length,
      skippedDuplicates: docs.length - uniqueDocs.length,
      skippedRewrite: true,
    };
  }

  let deleted = await deleteExistingOwnerPdcDocs(uniqueDocs);
  let imported = 0;

  for (const { id: eventId, data: docData } of docEntries) {
    const batch = db().batch();
    const eventRef = ownerRef.collection("events").doc(eventId);
    const csvRowRef = ownerRef.collection("csvRows").doc(eventId);
    const mirrorRef = db().collection(PDC_FLAT_MIRROR_COLLECTION).doc(eventId);
    batch.set(ownerRef, {
      owner: docData.owner,
      uid: docData.uid,
      display_name: docData.display_name || docData.pdc_user_name || "",
      pdc_user_name: docData.pdc_user_name || "",
      email: docData.email || "",
      source: SLACK_ICAL_SOURCE,
      sourceHash,
      sourceHashUpdatedAt: nowTimestamp(),
      rewrittenAt: nowTimestamp(),
      updatedAt: nowTimestamp(),
    }, { merge: true });
    batch.set(eventRef, docData, { merge: false });
    batch.set(csvRowRef, importedPdcDocToCsvRowDoc(docData, eventId), { merge: false });
    batch.set(mirrorRef, docData, { merge: false });
    await batch.commit();
    imported += 1;
  }

  return { deleted, imported, skippedDuplicates: docs.length - uniqueDocs.length, skippedRewrite: false };
}

function importedPdcDocToRosterRow(doc) {
  return [
    cleanText(doc.DateRaw || doc.Date, 20),
    cleanText(doc.DC || doc["D/C"], 20),
    cleanText(doc.CIL || doc["C/I(L)"], 20),
    cleanText(doc.COL || doc["C/O(L)"], 20),
    cleanText(doc.Activity, 80),
    cleanText(doc.F || doc.Activity, 80),
    cleanText(doc.From, 10),
    cleanText(doc.STDL || doc["STD(L)"], 40),
    cleanText(doc.STDZ || doc["STD(Z)"], 40),
    cleanText(doc.To || doc.Destination, 10),
    cleanText(doc.STAL || doc["STA(L)"], 40),
    cleanText(doc.STAZ || doc["STA(Z)"], 40),
    cleanText(doc.BLH, 40),
    cleanText(doc.AcReg || doc.ACReg || doc.REG || doc.Reg, 40),
    cleanText(doc.Crew, 1000),
  ];
}

function importedPdcDocToCsvRowDoc(doc, eventId = "") {
  const row = importedPdcDocToRosterRow(doc);
  const data = Object.fromEntries(ROSTER_HEADERS.map((header, index) => [header, row[index] || ""]));
  return {
    ...data,
    owner: cleanText(doc.owner || doc.uid, 500),
    uid: cleanText(doc.uid || doc.owner, 500),
    eventId,
    sortKey: dateSortKey(row[0]),
    source: SLACK_ICAL_SOURCE,
    updatedAt: nowTimestamp(),
  };
}

function writeImportedRosterJson(docs, ownerUid) {
  const rows = docs
    .filter((doc) => cleanText(doc.Activity, 80) && cleanText(doc.From, 10) && cleanText(doc.To || doc.Destination, 10))
    .sort((a, b) => {
      const left = `${cleanText(a.DateRaw || a.Date, 20)}_${cleanText(a.STDZ || a.STDL, 40)}_${cleanText(a.Activity, 80)}`;
      const right = `${cleanText(b.DateRaw || b.Date, 20)}_${cleanText(b.STDZ || b.STDL, 40)}_${cleanText(b.Activity, 80)}`;
      return left.localeCompare(right);
    })
    .map(importedPdcDocToRosterRow);
  const safeOwner = cleanText(ownerUid, 500).replace(/[^A-Za-z0-9_-]/g, "_") || "owner";
  const filePath = path.join(os.tmpdir(), `slack-import-roster-${safeOwner}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ values: [ROSTER_HEADERS, ...rows] }, null, 2), "utf-8");
  return { filePath, rowCount: rows.length };
}

async function rewriteImportedPerDiem(docs, owner) {
  const { filePath, rowCount } = writeImportedRosterJson(docs, owner.uid);
  if (!rowCount) return { deleted: 0, written: 0, skippedDuplicates: 0, rowCount };
  const result = await generateAndRewriteSlackPerDiem(db(), filePath, {
    owner: owner.uid,
    uid: owner.uid,
    userId: owner.uid,
    email: owner.email || "",
    displayName: owner.displayName || "",
  });
  return { ...result, rowCount };
}

function isOffDuty(activity) {
  return /^(REST|OFF|OFFD|DAY OFF|DO|VAC|LEAVE|RSV)$/i.test(cleanText(activity, 40));
}

async function emailImportOwnersForSlackTeam(command) {
  if (!command.teamId) return [];

  const owners = new Map();

  const teamOwnersSnapshot = await db()
    .collection(SLACK_TEAM_OWNER_COLLECTION)
    .where("slackTeamId", "==", command.teamId)
    .get();

  for (const doc of teamOwnersSnapshot.docs) {
    const data = doc.data();
    if (data.status === "disabled") continue;

    const uid = cleanText(data.ownerUid || data.uid || "", 160);
    if (!uid || uid.startsWith("guest_")) continue;

    owners.set(uid, {
      uid,
      relation: "slack_team_owner",
      scope: "layover_only",
      displayName: data.displayName || data.email || uid,
      email: data.email || "",
    });
  }

  const linkSnapshot = await db()
    .collection(SLACK_LINK_COLLECTION)
    .where("slackTeamId", "==", command.teamId)
    .get();

  for (const doc of linkSnapshot.docs) {
    const link = doc.data();
    if (link.status === "disabled") continue;

    const uid = cleanText(
      link.lastImportedOwnerUid ||
      link.firebaseUid ||
      link.uid ||
      link.owner ||
      "",
      160
    );

    if (!uid || uid.startsWith("guest_")) continue;

    owners.set(uid, {
      uid,
      relation: "slack_link",
      scope: "layover_only",
      displayName:
        link.lastImportedOwnerDisplayName ||
        link.firebaseDisplayName ||
        link.lastImportedOwnerEmail ||
        link.recipientEmail ||
        link.firebaseEmail ||
        link.slackUserName ||
        uid,
      email:
        link.lastImportedOwnerEmail ||
        link.recipientEmail ||
        link.firebaseEmail ||
        "",
    });
  }

  console.log("SLACK_TEAM_ROSTER_OWNERS", {
    teamId: command.teamId,
    ownerCount: owners.size,
    ownerUids: [...owners.keys()],
  });

  return [...owners.values()];
}

async function sharedOwnersFor(uid, command = {}) {
  const owners = new Map();

  function ownerKey(owner) {
    const email = cleanText(owner?.email || "", 240).toLowerCase();
    if (email) return `email:${email}`;
    return `uid:${cleanText(owner?.uid || "", 160)}`;
  }

  function addOwner(owner) {
    if (!owner?.uid || cleanText(owner.uid, 160).startsWith("guest_")) return;

    const key = ownerKey(owner);
    const existing = owners.get(key);

    if (!existing) {
      owners.set(key, owner);
      return;
    }

    const existingName = cleanText(existing.displayName || "", 200);
    const candidateName = cleanText(owner.displayName || "", 200);
    const existingLooksLikeUid =
      !existingName ||
      existingName === existing.uid ||
      /^[A-Za-z0-9_-]{20,}$/.test(existingName);
    const candidateLooksLikeUid =
      !candidateName ||
      candidateName === owner.uid ||
      /^[A-Za-z0-9_-]{20,}$/.test(candidateName);

    if (existingLooksLikeUid && !candidateLooksLikeUid) {
      owners.set(key, { ...existing, ...owner });
    }
  }

  addOwner({
    uid,
    relation: "self",
    scope: "full",
    ...(await publicUser(uid)),
  });

  const shares = await db()
    .collection(SHARE_COLLECTION)
    .where("sharedWithUid", "==", uid)
    .get();

  for (const doc of shares.docs) {
    const share = doc.data();
    if (share.status !== "active" || !share.ownerUid) continue;

    addOwner({
      uid: share.ownerUid,
      relation: "shared",
      scope: share.scope || "layover_only",
      displayName: share.ownerDisplayName || "",
      email: share.ownerEmail || "",
    });
  }

  for (const owner of await emailImportOwnersForSlackTeam(command)) {
    addOwner(owner);
  }

  const result = [...owners.values()];
  console.log("SHARED_OWNERS_FOR", {
    requesterUid: uid,
    teamId: command.teamId || "",
    ownerCount: result.length,
    owners: result.map((owner) => ({
      uid: owner.uid,
      relation: owner.relation,
      displayName: owner.displayName || "",
      email: owner.email || "",
    })),
  });

  return result;
}

function rosterItem(doc, owner) {
  const data = doc.data();
  const sourcePath = doc.ref?.path || "";
  const sourceCollection = sourcePath.split("/")[0] || "";
  const activity = cleanText(data.Activity, 80);
  const crewArray = Array.isArray(data.CrewArray)
    ? data.CrewArray.map((name) => cleanText(name, 40)).filter(Boolean)
    : [];
  return {
    ownerUid: data.owner || owner.uid,
    eventId: doc.id,
    sourceCollection,
    crewName: owner.displayName || data.ownerDisplayName || "",
    date: cleanText(data.Date, 20),
    activity,
    from: upper(data.From),
    to: upper(data.To),
    stdl: cleanText(data.STDL || data["STD(L)"], 20),
    stal: cleanText(data.STAL || data["STA(L)"], 20),
    stdz: cleanText(data.STDZ || data["STD(Z)"], 20),
    staz: cleanText(data.STAZ || data["STA(Z)"], 20),
    dc: cleanText(data.DC || data["D/C"], 20),
    cil: cleanText(data.CIL || data["C/I(L)"], 20),
    col: cleanText(data.COL || data["C/O(L)"], 20),
    f: cleanText(data.F || activity, 80),
    blh: cleanText(data.BLH, 40),
    acReg: cleanText(data.AcReg || data.ACReg || data.REG || data.Reg, 40),
    crew: cleanText(data.Crew, 1000),
    crewArray,
    type: isOffDuty(activity) ? "day_off" : "flight",
  };
}

async function ownerRosterDocs(ownerUid) {
  const normalizedUid = cleanText(ownerUid, 500);
  if (!normalizedUid) {
    console.warn("OWNER_ROSTER_DOCS_NO_UID");
    return [];
  }

  if (normalizedUid.startsWith("guest_")) {
    console.warn("OWNER_ROSTER_DOCS_GUEST_UID_BLOCKED", {
      ownerUid: normalizedUid,
    });
    return [];
  }

  const ownerDocId = ownerPdcDocId(normalizedUid);
  const [rosterSnapshot, pdcEventsSnapshot] = await Promise.all([
    db().collection(ROSTER_COLLECTION).where("owner", "==", normalizedUid).get(),
    db().collection(PDC_COLLECTION).doc(ownerDocId).collection("events").get(),
  ]);

  console.log("OWNER_ROSTER_DOCS", {
    ownerUid: normalizedUid,
    ownerDocId,
    rosterCount: rosterSnapshot.size,
    pdcEventCount: pdcEventsSnapshot.size,
    pdcPath: `${PDC_COLLECTION}/${ownerDocId}/events`,
    source: rosterSnapshot.empty ? "pdc_events_fallback" : "roster",
  });

  if (!rosterSnapshot.empty) return rosterSnapshot.docs;
  return pdcEventsSnapshot.docs;
}

async function layoverItemsFor(uid, { station, startDate, days }, command = {}) {
  const endDate = addDays(startDate, days - 1);
  const startKey = dateSortKey(startDate);
  const endKey = dateSortKey(endDate);
  const owners = await sharedOwnersFor(uid, command);
  const nested = await Promise.all(
    owners.map(async (owner) => {
      const docs = await ownerRosterDocs(owner.uid);
      return docs
        .map((doc) => rosterItem(doc, owner))
        .filter((item) => item.type === "flight")
        .filter((item) => {
          const key = dateSortKey(item.date);
          return key >= startKey && key <= endKey;
        })
        .filter((item) => !station || item.from === station || item.to === station);
    })
  );
  return dedupeRosterItems(nested.flat(), { ignoreTimes: true }).sort((a, b) => {
    const left = `${dateSortKey(a.date)}_${a.stdl}_${a.crewName}_${a.activity}`;
    const right = `${dateSortKey(b.date)}_${b.stdl}_${b.crewName}_${b.activity}`;
    return left.localeCompare(right);
  });
}

async function rosterCalendarItemsFor(uid, { station, startDate, days }, command = {}) {
  const endDate = addDays(startDate, days - 1);
  const startKey = dateSortKey(startDate);
  const endKey = dateSortKey(endDate);
  const owners = await sharedOwnersFor(uid, command);
  const nested = await Promise.all(
    owners.map(async (owner) => {
      const docs = await ownerRosterDocs(owner.uid);
      return docs
        .map((doc) => rosterItem(doc, owner))
        .filter((item) => item.type === "flight")
        .filter((item) => {
          const key = dateSortKey(item.date);
          return key >= startKey && key <= endKey;
        })
        .filter((item) => !station || item.from === station || item.to === station);
    })
  );
  return dedupeRosterItems(nested.flat(), { ignoreTimes: true }).sort((a, b) => {
    const left = `${dateSortKey(a.date)}_${a.stdl || a.stal}_${a.crewName}_${a.activity}`;
    const right = `${dateSortKey(b.date)}_${b.stdl || b.stal}_${b.crewName}_${b.activity}`;
    return left.localeCompare(right);
  });
}

function dedupeRosterItems(items, { ignoreTimes = false } = {}) {
  if (ignoreTimes) return dedupeNearDuplicateRosterItems(items);

  const byKey = new Map();
  for (const item of items) {
    const key = [
      item.ownerUid,
      dateSortKey(item.date),
      ignoreTimes ? "" : item.stdl,
      ignoreTimes ? "" : item.stal,
      item.activity,
      item.from,
      item.to,
      crewKey(item),
    ].join("|");
    byKey.set(key, preferredRosterItem(byKey.get(key), item));
  }
  return [...byKey.values()];
}

function rosterItemDuplicateKey(item) {
  return [
    item.ownerUid,
    item.activity,
    item.from,
    item.to,
    crewKey(item),
  ].join("|");
}

function looksLikeSameRosterItem(a, b) {
  if (rosterItemDuplicateKey(a) !== rosterItemDuplicateKey(b)) return false;
  const dayDiff = Math.abs(dayNumber(a.date) - dayNumber(b.date));
  if (dayDiff === 0) return true;
  if (dayDiff !== 1) return false;

  const aTime = timeMinutes(a.stdl || a.stal);
  const bTime = timeMinutes(b.stdl || b.stal);
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return false;
  return Math.max(aTime, bTime) >= 20 * 60 && Math.min(aTime, bTime) <= 4 * 60;
}

function canonicalCrewSignature(item) {
  const crew = Array.isArray(item?.crewArray) ? item.crewArray : [];
  return crew
    .map((name) => cleanText(name, 40))
    .filter(Boolean)
    .sort()
    .join(",");
}

function rosterFlightIdentity(item) {
  // Keep different roster owners on the same flight as separate layover entries.
  // This still collapses duplicate records belonging to the same owner.
  return [
    rosterOwnerIdentity(item),
    dateSortKey(item.date),
    cleanText(item.activity, 80).toUpperCase(),
    upper(item.from),
    upper(item.to),
  ].join("|");
}

function rosterOwnerIdentity(item) {
  return cleanText(item.ownerUid || item.crewName || "", 160).toLowerCase();
}

function preferredLayoverRosterItem(current, candidate) {
  if (!current) return candidate;

  const currentCrewCount = Array.isArray(current.crewArray) ? current.crewArray.length : 0;
  const candidateCrewCount = Array.isArray(candidate.crewArray) ? candidate.crewArray.length : 0;

  // Prefer the record with the richer crew list.
  if (candidateCrewCount !== currentCrewCount) {
    return candidateCrewCount > currentCrewCount ? candidate : current;
  }

  // Prefer human-readable names over raw Firebase UID display.
  const currentLooksLikeUid =
    !current.crewName ||
    current.crewName === current.ownerUid ||
    /^[A-Za-z0-9_-]{20,}$/.test(current.crewName);
  const candidateLooksLikeUid =
    !candidate.crewName ||
    candidate.crewName === candidate.ownerUid ||
    /^[A-Za-z0-9_-]{20,}$/.test(candidate.crewName);

  if (currentLooksLikeUid !== candidateLooksLikeUid) {
    return currentLooksLikeUid ? candidate : current;
  }

  // Finally prefer the record with a readable local time.
  const currentHasColon = /:/.test(cleanText(current.stdl || current.stal, 20));
  const candidateHasColon = /:/.test(cleanText(candidate.stdl || candidate.stal, 20));
  if (currentHasColon !== candidateHasColon) {
    return candidateHasColon ? candidate : current;
  }

  return preferredRosterItem(current, candidate);
}

function dedupeNearDuplicateRosterItems(items) {
  const byFlight = new Map();

  for (const item of items) {
    const flightKey = rosterFlightIdentity(item);
    const current = byFlight.get(flightKey);

    if (!current) {
      byFlight.set(flightKey, item);
      continue;
    }

    const sameOwner =
      rosterOwnerIdentity(current) === rosterOwnerIdentity(item);

    const sameCrew =
      canonicalCrewSignature(current) === canonicalCrewSignature(item);

    // Same dated flight/route from duplicate owner aliases or duplicate PDC/roster
    // records should be shown once. Prefer the most complete, readable record.
    if (sameOwner || sameCrew || flightKey) {
      byFlight.set(
        flightKey,
        preferredLayoverRosterItem(current, item)
      );
    }
  }

  return [...byFlight.values()];
}

function preferredRosterItem(current, candidate) {
  if (!current) return candidate;
  const currentDateTime = `${dateSortKey(current.date)} ${cleanText(current.stdl || current.stal, 40)}`;
  const candidateDateTime = `${dateSortKey(candidate.date)} ${cleanText(candidate.stdl || candidate.stal, 40)}`;
  return candidateDateTime >= currentDateTime ? candidate : current;
}

async function myRosterItemsFor(uid, { station, startDate, days }) {
  const owner = { uid, relation: "self", scope: "full", ...(await publicUser(uid)) };
  const endDate = addDays(startDate, days - 1);
  const startKey = dateSortKey(startDate);
  const endKey = dateSortKey(endDate);
  const docs = await ownerRosterDocs(uid);
  const items = docs
    .map((doc) => rosterItem(doc, owner))
    .filter((item) => item.date && item.activity)
    .filter((item) => {
      const key = dateSortKey(item.date);
      return key >= startKey && key <= endKey;
    })
    .filter((item) => !station || item.from === station || item.to === station);
  return dedupeRosterItems(items, { ignoreTimes: true }).sort((a, b) => {
    const left = `${dateSortKey(a.date)}_${a.stdl}_${a.activity}_${a.from}_${a.to}`;
    const right = `${dateSortKey(b.date)}_${b.stdl}_${b.activity}_${b.from}_${b.to}`;
    return left.localeCompare(right);
  });
}

function helpText() {
  return [
    "*Roster Slack commands*",
    "`/roster-share` - create a Roster Share invite link",
    "`/roster-share friend@example.com` - create an invite link with an email-compose button",
    "`/roster-share link-me` - link your Slack user to the default Firebase roster user",
    "`/roster-share import webcal://...` - import your personal iCal roster privately",
    "`/roster-share import friend@example.com webcal://...` - link that Slack user to an email owner and import",
    "`/roster-update webcal://...` - shortcut for roster iCal import/update",
    "`/roster-update friend@example.com webcal://...` - shortcut for email owner import/update",
    "`/roster-calendar` - show shared roster in a calendar-style list",
    "`/roster-calendar 2026-08` - show shared roster for a month",
    "`/roster-calendar HNL 2026-08` - filter shared roster by station",
    "`/my-roster` - show only your roster for today + 30 days",
    "`/my-roster HNL 2026-07-22 14` - show only your roster with optional station/date/days",
    "`/perdiem-report` - show your monthly PerDiem report in Slack",
    "`/perdiem-report user@example.com jul` - show that user's July PerDiem report",
    "`/perdiem-report set-email user@example.com` - save your default PerDiem report owner email",
    "`/layover HNL` - show shared HNL crew for today + 30 days",
    "`/layover HNL 2026-07-22 14` - choose start date and days",
    `User guide: ${slackRosterGuideUrl()}`,
  ].join("\n");
}

function notLinkedText(command) {
  return [
    `Slack user <@${command.userId}> is not linked to a Firebase roster user yet.`,
    "",
    "Create this Firestore document first:",
    `collection: \`${SLACK_LINK_COLLECTION}\``,
    `document: \`${slackLinkId(command.teamId, command.userId)}\``,
    "fields:",
    `- \`firebaseUid\`: your Firebase UID, for example \`kakao_...\``,
    `- \`slackTeamId\`: \`${command.teamId}\``,
    `- \`slackUserId\`: \`${command.userId}\``,
  ].join("\n");
}

async function handleRosterShare(command) {
  const args = parseSlackArgs(command.text);
  const action = cleanText(args[0] || "", 40).toLowerCase();
  if (["link-me", "linkme", "connect-me", "connectme"].includes(action)) {
    const link = await linkSlackUserToDefaultUid(command);
    return {
      response_type: "ephemeral",
      text: [
        "Slack user linked to Firebase roster user.",
        `Firestore document: \`${SLACK_LINK_COLLECTION}/${link.linkId}\``,
        `Firebase user: \`${link.owner.displayName || link.owner.email || link.firebaseUid}\``,
      ].join("\n"),
    };
  }

  const isImportAction = ["import", "sync", "link", "ical", "webcal"].includes(action);

  if (isImportAction) {
    return handleRosterImport(command);
  }

  const firebaseUid = await linkedFirebaseUid(command, { allowDefault: true });
  if (!firebaseUid) {
    return {
      response_type: "ephemeral",
      text: notLinkedText(command),
    };
  }

  const recipientEmail = looksLikeEmail(args[0]) ? cleanText(args[0], 240) : "";
  const scopeArgIndex = recipientEmail ? 1 : 0;
  const scope = cleanText(args[scopeArgIndex] || "layover_only", 40) || "layover_only";
  const invite = await createInviteForUid(firebaseUid, {
    scope,
    note: `Created from Slack ${command.teamDomain || command.teamId} #${command.channelName || command.channelId}`,
  });
  const channelUrl = slackChannelUrl(command);
  const shareText = inviteShareText(invite.inviteUrl, channelUrl);
  const mailUrl = mailInviteUrl({
    inviteUrl: invite.inviteUrl,
    ownerName: invite.owner.displayName || invite.owner.email || command.userName,
    recipientEmail,
    channelUrl,
  });
  const emailHint = recipientEmail ? `\nEmail recipient: \`${recipientEmail}\`` : "";

  return {
    response_type: "ephemeral",
    text: `Roster Share invite created: ${invite.inviteUrl}\n\n${shareText}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Roster Share invite created*\nScope: \`${scope}\`${emailHint}\n\n*Slack DM/채널에 아래 문구를 복사해서 보내세요:*\n\`\`\`${shareText}\`\`\``,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open invite" },
            url: invite.inviteUrl,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Send by email" },
            url: mailUrl,
          },
          ...(channelUrl
            ? [{
                type: "button",
                text: { type: "plain_text", text: "Open channel" },
                url: channelUrl,
              }]
            : []),
        ],
      },
    ],
  };
}

async function handleRosterImport(command) {
  const calendarUrl = extractRosterCalendarUrl(command.text);
  if (!calendarUrl) {
    return {
      response_type: "ephemeral",
      text: "Usage: `/roster-share import webcal://...` or `/roster-share import friend@example.com webcal://...`",
    };
  }

  const email = importEmailArg(command.text);
  let firebaseUid = "";
  let owner = {};
  let autoLinked = null;
  if (email) {
    autoLinked = await resolveImportOwnerForEmail(command, email);
    firebaseUid = autoLinked.firebaseUid;
    owner = autoLinked.owner;
    autoLinked.sharedWithCount = await autoShareOwnerWithSlackTeam(command, owner);
  } else {
    firebaseUid = await linkedFirebaseUid(command, { allowDefault: false });
    if (!firebaseUid) {
      return {
        response_type: "ephemeral",
        text: `${notLinkedText(command)}\n\nRoster iCal import requires a personal Slack-to-Firebase link. Or use: \`/roster-share import friend@example.com webcal://...\``,
      };
    }
    owner = await publicUser(firebaseUid);
  }

  const dispatch = await dispatchIcalImportWorkflow({ calendarUrl, firebaseUid, owner });
  if (dispatch.dispatched) {
    return {
      response_type: "ephemeral",
      text: [
        `Roster iCal import workflow queued: ${dispatch.actionsUrl}`,
        `Owner: \`${owner.displayName || owner.email || firebaseUid}\``,
        ...(autoLinked ? [`Slack link: \`${SLACK_LINK_COLLECTION}/${autoLinked.linkId}\``] : []),
        ...(autoLinked ? [`Auto shared with ${autoLinked.sharedWithCount} Slack roster participant(s).`] : []),
      ].join("\n"),
    };
  }

  const ics = await fetchIcsCalendar(calendarUrl);
  const docs = parseIcsEvents(ics)
    .map((event) => icsEventToRosterDoc(event, { uid: firebaseUid, ...owner }))
    .filter(Boolean);

  if (!docs.length) {
    return {
      response_type: "ephemeral",
      text: "iCal calendar was fetched, but no roster events were found.",
    };
  }

  const result = await uploadImportedRosterToPdc(docs);
  const perdiemResult = await rewriteImportedPerDiem(docs, { uid: firebaseUid, ...owner });
  const pdcAction = result.skippedRewrite ? "Skipped unchanged pdc rewrite" : "Rewrote pdc for this owner";
  const perdiemAction = perdiemResult.skippedRewrite ? "Skipped unchanged Perdiem rewrite" : "Rewrote Perdiem";
  return {
    response_type: "ephemeral",
    text: `Roster iCal import complete. ${pdcAction}: saved ${result.imported} event(s), removed ${result.deleted} previous owner event(s), skipped ${result.skippedDuplicates} duplicate event(s). ${perdiemAction}: saved ${perdiemResult.written} event(s), removed ${perdiemResult.deleted} previous event(s), skipped ${perdiemResult.skippedDuplicates} duplicate event(s).`,
  };
}

function parseLayoverText(text) {
  const parts = cleanText(text, 200).split(/\s+/).filter(Boolean);
  const station = upper(parts[0] || "");
  const startDate = cleanDate(parts[1]) || todaySeoul();
  const days = Math.min(Math.max(Number.parseInt(parts[2] || "30", 10) || 30, 1), 30);
  return { station, startDate, days };
}

function parseMyRosterText(text) {
  const parts = cleanText(text, 200).split(/\s+/).filter(Boolean);
  let station = "";
  let startDate = todaySeoul();
  let days = 30;

  for (const part of parts) {
    const date = cleanDate(part);
    const number = Number.parseInt(part, 10);
    if (date) {
      startDate = date;
    } else if (/^\d{1,3}$/.test(part) && !Number.isNaN(number)) {
      days = Math.min(Math.max(number, 1), 30);
    } else if (!station) {
      station = upper(part);
    }
  }

  return { station, startDate, days };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseRosterCalendarText(text) {
  const parts = cleanText(text, 200).split(/\s+/).filter(Boolean);
  const today = todaySeoul();
  let [yearText, monthText] = today.slice(0, 7).split("-");
  let station = "";
  let days = 0;

  for (const part of parts) {
    const token = part.replace(/[\\/.,;:]+$/g, "");
    const monthMatch = token.match(/^(\d{4})[-.](\d{1,2})$/);
    const number = Number.parseInt(token, 10);
    if (monthMatch) {
      yearText = monthMatch[1];
      monthText = monthMatch[2].padStart(2, "0");
    } else if (/^\d{1,3}$/.test(token) && !Number.isNaN(number)) {
      days = Math.min(Math.max(number, 1), 45);
    } else if (!station) {
      station = upper(token);
    }
  }

  const year = Number(yearText);
  const month = Number(monthText);
  return {
    station,
    startDate: `${yearText}-${monthText}-01`,
    days: days || daysInMonth(year, month),
    monthLabel: `${monthName(month)} ${yearText}`,
  };
}

function rosterEventUrl(item) {
  const params = new URLSearchParams({
    owner: cleanText(item.ownerUid, 500),
    event: cleanText(item.eventId, 500),
  });
  return `${appBaseUrl()}/roster-event/?${params.toString()}`;
}

function calendarDay(value) {
  const key = dateSortKey(value);
  const match = key.match(/^\d{4}-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}/${match[2]}` : cleanText(value, 10);
}

function calendarTimeLabel(item) {
  return item.to === "ICN" ? "RO" : "STD";
}

function calendarTime(item) {
  return formatCalendarTime(item.to === "ICN"
    ? cleanText(item.stal || item.stdl, 20)
    : cleanText(item.stdl || item.stal, 20));
}

function formatCalendarTime(value) {
  const text = cleanText(value, 20);
  const fourDigit = text.match(/^(\d{2})(\d{2})$/);
  if (fourDigit) return `${fourDigit[1]}:${fourDigit[2]}`;
  const threeDigit = text.match(/^(\d)(\d{2})$/);
  if (threeDigit) return `0${threeDigit[1]}:${threeDigit[2]}`;
  return text;
}

function calendarCrewName(item) {
  const name = cleanText(item.crewName || item.ownerUid, 80);
  if (!name.includes("@")) return name;
  return cleanText(name.split("@")[0], 80);
}

function rosterCalendarLine(item, { includeName = true } = {}) {
  const route = [item.from, item.to].filter(Boolean).join("-");
  const url = rosterEventUrl(item);
  const name = includeName ? `${calendarCrewName(item)}  ` : "";
  const timeLabel = calendarTimeLabel(item);
  const time = calendarTime(item);
  return `${calendarDay(item.date)}  ${name}${item.activity} ${route}  ${timeLabel} ${time}  <${url}|Crew 보기>`.trim();
}

function rosterCalendarResponseText({ station, monthLabel, items }) {
  const stationText = station ? ` ${station}` : "";
  if (!items.length) return `No shared roster found${stationText} for ${monthLabel}.`;
  const lines = items.slice(0, 40).map(rosterCalendarLine);
  const suffix = items.length > 40 ? `\n…and ${items.length - 40} more` : "";
  return `*${monthLabel} Shared Roster${stationText}*\n${lines.join("\n")}${suffix}`;
}

function layoverResponseText({ station, startDate, days, items }) {
  if (!station) return "Usage: `/layover HNL` or `/layover HNL 2026-07-22 14`";
  if (!items.length) {
    return `No shared crew found for ${station} from ${startDate} for ${days} day(s).`;
  }

  const lines = items.slice(0, 40).map(rosterCalendarLine);
  const suffix = items.length > 40 ? `\n…and ${items.length - 40} more` : "";
  return `*${station} shared layover crew* (${startDate}, ${days} day(s))\n${lines.join("\n")}${suffix}`;
}

function myRosterResponseText({ station, startDate, days, items }) {
  const stationText = station ? ` ${station}` : "";
  if (!items.length) {
    return `No personal roster found${stationText} from ${startDate} for ${days} day(s).`;
  }

  const lines = items
    .slice(0, 40)
    .map((item) => rosterCalendarLine(item, { includeName: false }));
  const suffix = items.length > 40 ? `\n…and ${items.length - 40} more` : "";
  return `*My roster${stationText}* (${startDate}, ${days} day(s))\n${lines.join("\n")}${suffix}`;
}

function rosterItemCrewText(item) {
  const crewList = Array.isArray(item.crewArray) ? item.crewArray.filter(Boolean) : [];
  return item.crew || crewList.join(", ");
}

function myRosterCsv({ items }) {
  const rows = items.map((item) => [
    dateSortKey(item.date),
    item.dc,
    item.cil,
    item.col,
    item.activity,
    item.f || item.activity,
    item.from,
    formatCalendarTime(item.stdl),
    formatCalendarTime(item.stdz),
    item.to,
    formatCalendarTime(item.stal),
    formatCalendarTime(item.staz),
    item.blh,
    item.acReg,
    rosterItemCrewText(item),
  ]);
  return [ROSTER_HEADERS, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

function csvRowsToCsv(rows) {
  return [ROSTER_HEADERS, ...rows.map((row) => ROSTER_HEADERS.map((header) => row[header] ?? ""))]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

async function myRosterCsvRowsFor(uid, { station, startDate, days }) {
  const endDate = addDays(startDate, days - 1);
  const startKey = dateSortKey(startDate);
  const endKey = dateSortKey(endDate);
  const snapshot = await db()
    .collection(PDC_COLLECTION)
    .doc(ownerPdcDocId(uid))
    .collection("csvRows")
    .get();
  return snapshot.docs
    .map((doc) => ({ eventId: doc.id, ...doc.data() }))
    .filter((row) => {
      const key = dateSortKey(row.sortKey || row.Date);
      return key >= startKey && key <= endKey;
    })
    .filter((row) => !station || upper(row.From) === station || upper(row.To) === station)
    .sort((a, b) => {
      const left = `${dateSortKey(a.sortKey || a.Date)}_${cleanText(a["STD(Z)"] || a["STD(L)"], 40)}_${cleanText(a.Activity, 80)}`;
      const right = `${dateSortKey(b.sortKey || b.Date)}_${cleanText(b["STD(Z)"] || b["STD(L)"], 40)}_${cleanText(b.Activity, 80)}`;
      return left.localeCompare(right);
    });
}

function safeFilePart(value, fallback = "my-roster") {
  return cleanText(value, 120).replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

async function uploadMyRosterCsv(command, parsed, items, csvRows = []) {
  if (!items.length) return false;
  const stationPart = parsed.station ? `_${safeFilePart(parsed.station, "station")}` : "";
  const filename = `my-roster_${safeFilePart(parsed.startDate, "date")}_${parsed.days}days${stationPart}.csv`;
  return uploadSlackCsv({
    command,
    filename,
    title: filename,
    csv: csvRows.length ? csvRowsToCsv(csvRows) : myRosterCsv({ items }),
    initialComment: `My roster CSV (${parsed.startDate}, ${parsed.days} day(s))`,
  });
}

async function handleLayover(command) {
  const parsed = parseLayoverText(command.text);
  if (!parsed.station) {
    return {
      response_type: "ephemeral",
      text: "Usage: `/layover HNL` or `/layover HNL 2026-07-22 14`",
    };
  }

  const firebaseUid = await linkedFirebaseUid(command, { allowDefault: true });
  console.log("LAYOVER_OWNER_RESOLVED", {
    teamId: command.teamId,
    userId: command.userId,
    firebaseUid: firebaseUid || "",
  });

  if (!firebaseUid || firebaseUid.startsWith("guest_")) {
    return { response_type: "ephemeral", text: notLinkedText(command) };
  }

  const items = await layoverItemsFor(firebaseUid, parsed, command);
  console.log("LAYOVER_RESULT", {
    firebaseUid,
    station: parsed.station,
    startDate: parsed.startDate,
    days: parsed.days,
    itemCount: items.length,
  });

  return {
    response_type: "ephemeral",
    text: layoverResponseText({ ...parsed, items }),
  };
}

async function handleMyRoster(command) {
  // Use the explicit Slack link first and fall back to
  // SLACK_DEFAULT_FIREBASE_UID when configured.
  const firebaseUid = await linkedFirebaseUid(command, { allowDefault: true });
  console.log("MY_ROSTER_OWNER_RESOLVED", {
    teamId: command.teamId,
    userId: command.userId,
    firebaseUid: firebaseUid || "",
  });

  if (!firebaseUid || firebaseUid.startsWith("guest_")) {
    return {
      response_type: "ephemeral",
      text: `${notLinkedText(command)}\n\nUse \`/roster-share link-me\` first, then run \`/my-roster\`.`,
    };
  }

  const parsed = parseMyRosterText(command.text);
  const items = await myRosterItemsFor(firebaseUid, parsed);
  console.log("MY_ROSTER_RESULT", {
    firebaseUid,
    station: parsed.station || "",
    startDate: parsed.startDate,
    days: parsed.days,
    itemCount: items.length,
  });

  try {
    const csvRows = await myRosterCsvRowsFor(firebaseUid, parsed);
    await uploadMyRosterCsv(command, parsed, items, csvRows);
  } catch (error) {
    console.warn("MY_ROSTER_CSV_UPLOAD_FAILED", {
      message: error.message,
      channelId: command.channelId || "",
    });
  }

  return {
    response_type: "ephemeral",
    text: myRosterResponseText({ ...parsed, items }),
  };
}

async function handleRosterCalendar(command) {
  const firebaseUid = await linkedFirebaseUid(command, { allowDefault: true });
  console.log("ROSTER_CALENDAR_OWNER_RESOLVED", {
    teamId: command.teamId,
    userId: command.userId,
    firebaseUid: firebaseUid || "",
  });

  if (!firebaseUid || firebaseUid.startsWith("guest_")) {
    return {
      response_type: "ephemeral",
      text: `${notLinkedText(command)}\n\nUse \`/roster-share link-me\` first, then run \`/roster-calendar\`.`,
    };
  }

  const parsed = parseRosterCalendarText(command.text);
  const items = await rosterCalendarItemsFor(firebaseUid, parsed, command);
  console.log("ROSTER_CALENDAR_RESULT", {
    firebaseUid,
    station: parsed.station || "",
    startDate: parsed.startDate,
    days: parsed.days,
    itemCount: items.length,
  });

  return {
    response_type: "ephemeral",
    text: rosterCalendarResponseText({ ...parsed, items }),
  };
}

async function handlePerDiemReport(command) {
  const parsed = parsePerDiemReportText(command.text);
  if (["set-email", "setemail", "email"].includes(parsed.action)) {
    if (!parsed.reportEmail) {
      return {
        response_type: "ephemeral",
        text: "Usage: `/perdiem-report set-email user@example.com`",
      };
    }
    return setPerDiemReportEmail(command, parsed.reportEmail);
  }

  const link = await slackLinkData(command);
  const savedReportEmail = cleanText(link?.perdiemReportEmail || "", 240).toLowerCase();
  const reportEmail = parsed.reportEmail || savedReportEmail;
  const requestedOwner = reportEmail ? await pdcOwnerForEmail(reportEmail) : null;
  if (reportEmail && !requestedOwner) {
    return {
      response_type: "ephemeral",
      text: `No pdc roster owner found for \`${reportEmail}\`. Run roster import for that email first, then retry \`/perdiem-report ${reportEmail} jul\`.`,
    };
  }

  const firebaseUid = requestedOwner?.firebaseUid || (await linkedFirebaseUid(command, { allowDefault: false }));
  if (!firebaseUid) {
    return {
      response_type: "ephemeral",
      text: `${notLinkedText(command)}\n\nUse \`/roster-share link-me\` first, or run \`/perdiem-report user@example.com jul\`.`,
    };
  }

  const owner = requestedOwner?.owner || await publicUser(firebaseUid);
  const dispatch = await dispatchPerDiemSlackWorkflow({
    command,
    firebaseUid,
    owner,
    ...parsed,
  });
  if (!dispatch.dispatched) {
    return {
      response_type: "ephemeral",
      text: "GITHUB_TOKEN is not configured on Vercel, so the Slack PerDiem workflow could not be queued.",
    };
  }

  const monthHint = perDiemMonthHint(parsed);
  return {
    response_type: "ephemeral",
    text: [
      `Monthly PerDiem Slack report workflow queued for ${monthHint}.`,
      `Owner: \`${owner.displayName || owner.email || firebaseUid}\`${reportEmail ? ` (${reportEmail})` : ""}`,
      dispatch.actionsUrl,
    ].join("\n"),
  };
}

async function handleCommand(command) {
  const commandName = cleanText(command.command, 80).toLowerCase();
  if (command.text === "help" || commandName === "/roster-help") {
    return { response_type: "ephemeral", text: helpText() };
  }
  if (commandName === "/roster-share") return handleRosterShare(command);
  if (commandName === "/roster-update") return handleRosterImport(command);
  if (commandName === "/roster-calendar") return handleRosterCalendar(command);
  if (commandName === "/my-roster") return handleMyRoster(command);
  if (commandName === "/perdiem-report") return handlePerDiemReport(command);
  if (commandName === "/layover") return handleLayover(command);
  return { response_type: "ephemeral", text: helpText() };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  let command = {};
  try {
    const rawBody = await readRawBody(req);
    verifySlackSignature(req, rawBody);
    command = parseSlashCommand(rawBody);
    if (command.responseUrl) {
      queueSlackWork(postCommandResult(command));
      slackJson(res, 200, {
        response_type: "ephemeral",
        text: `${command.command || "Roster command"} 처리 중입니다. 결과를 곧 보내드릴게요.`,
      });
      return;
    }

    slackJson(res, 200, await handleCommand(command));
  } catch (error) {
    const status = error.statusCode || 500;
    const isSlackAuthError = status === 401;
    slackJson(res, isSlackAuthError ? status : 200, {
      response_type: "ephemeral",
      text: `Slack command failed${command.command ? ` for ${command.command}` : ""}: ${error.message}`,
    });
  }
}

import crypto from "crypto";
import admin from "firebase-admin";
import { waitUntil } from "@vercel/functions";
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
const SHARE_ROSTER_COLLECTIONS = [ROSTER_COLLECTION, PDC_COLLECTION];
const SLACK_LINK_COLLECTION = "slack_user_links";
const SLACK_ICAL_SOURCE = "slack_ical";
const DEFAULT_GITHUB_REPO = "csj773/roster-sj";
const DEFAULT_GITHUB_REF = "main";
const ICAL_IMPORT_WORKFLOW_FILE = "import-ical-roster-to-pdc.yml";
const PERDIEM_SLACK_WORKFLOW_FILE = "monthly-perdiem-slack-report.yml";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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

async function slackLinkData(command) {
  const snap = await db()
    .collection(SLACK_LINK_COLLECTION)
    .doc(slackLinkId(command.teamId, command.userId))
    .get();
  return snap.exists ? snap.data() : null;
}

async function linkedFirebaseUid(command, { allowDefault = true } = {}) {
  const data = await slackLinkData(command);
  if (data) {
    const linkedUid = cleanText(data.firebaseUid || data.uid || "", 160);
    if (linkedUid && data.status !== "disabled") return linkedUid;
  }

  if (!allowDefault) return "";

  const configuredUid = cleanText(process.env.SLACK_DEFAULT_FIREBASE_UID || "", 160);
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

  return {
    linkId,
    firebaseUid,
    owner,
  };
}

function guestEmailUid(email) {
  return `guest_email_${cleanText(email, 240).toLowerCase()}`.replace(/[^A-Za-z0-9_-]/g, "_");
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

async function resolveImportOwnerForEmail(command, email) {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  const invite = await acceptedInviteForEmail(normalizedEmail);
  const firebaseUid = cleanText(invite?.acceptedByUid || "", 160) || (
    invite ? guestInviteUid(invite.code) : guestEmailUid(normalizedEmail)
  );
  const displayName = displayNameForEmail(normalizedEmail) || normalizedEmail || command.userName || "Roster Share guest";
  const linkId = slackLinkId(command.teamId, command.userId);

  await db().collection("users").doc(firebaseUid).set({
    uid: firebaseUid,
    email: normalizedEmail,
    display_name: displayName,
    displayName,
    provider: "slack_guest_import",
    providers: ["slack_guest_import"],
    updated_time: nowTimestamp(),
    created_time: nowTimestamp(),
  }, { merge: true });

  await db().collection(SLACK_LINK_COLLECTION).doc(linkId).set({
    firebaseUid,
    uid: firebaseUid,
    slackTeamId: command.teamId,
    slackTeamDomain: command.teamDomain || "",
    slackUserId: command.userId,
    slackUserName: command.userName || "",
    recipientEmail: normalizedEmail,
    firebaseDisplayName: displayName,
    firebaseEmail: normalizedEmail,
    inviteCode: invite?.code || "",
    status: "active",
    source: invite ? "slack_import_email_invite" : "slack_import_email",
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  }, { merge: true });

  return {
    firebaseUid,
    owner: {
      uid: firebaseUid,
      displayName,
      email: normalizedEmail,
    },
    linkId,
    inviteCode: invite?.code || "",
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

async function dispatchPerDiemSlackWorkflow({ command, firebaseUid, owner, targetMonth, targetYear }) {
  const token = process.env.GITHUB_TOKEN || "";
  if (!token) return { dispatched: false };

  const repo = process.env.GITHUB_REPO || DEFAULT_GITHUB_REPO;
  const ref = process.env.GITHUB_REF || DEFAULT_GITHUB_REF;
  const workflowFile = process.env.GITHUB_PERDIEM_SLACK_WORKFLOW_FILE || PERDIEM_SLACK_WORKFLOW_FILE;
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
        current_user_email: owner.email || "",
        current_user_uid: firebaseUid,
        current_user_name: owner.displayName || owner.email || command.userName || "",
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
    guestEmailUid(normalizedEmail),
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

  const eventsSnapshot = await db()
    .collection(PDC_COLLECTION)
    .doc(ownerPdcDocId(owner))
    .collection("events")
    .get();
  for (const doc of eventsSnapshot.docs) {
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
  const text = cleanText(value, 500).replace(/[*>.,;)\]]+$/g, "");
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
  let deleted = await deleteExistingOwnerPdcDocs(uniqueDocs);
  let imported = 0;

  for (const docData of uniqueDocs) {
    const batch = db().batch();
    const ownerRef = db().collection(PDC_COLLECTION).doc(ownerPdcDocId(docData.owner));
    const eventRef = ownerRef.collection("events").doc(pdcEventDocId(docData));
    batch.set(ownerRef, {
      owner: docData.owner,
      uid: docData.uid,
      display_name: docData.display_name || docData.pdc_user_name || "",
      pdc_user_name: docData.pdc_user_name || "",
      email: docData.email || "",
      updatedAt: nowTimestamp(),
    }, { merge: true });
    batch.set(eventRef, docData, { merge: true });
    batch.set(db().collection(PDC_COLLECTION).doc(), docData);
    await batch.commit();
    imported += 1;
  }

  return { deleted, imported, skippedDuplicates: docs.length - uniqueDocs.length };
}

function isOffDuty(activity) {
  return /^(REST|OFF|OFFD|DAY OFF|DO|VAC|LEAVE|RSV)$/i.test(cleanText(activity, 40));
}

async function emailImportOwnersForSlackTeam(command) {
  if (!command.teamId) return [];
  const snap = await db()
    .collection(SLACK_LINK_COLLECTION)
    .where("slackTeamId", "==", command.teamId)
    .get();

  const owners = new Map();
  for (const doc of snap.docs) {
    const link = doc.data();
    if (link.status === "disabled") continue;
    const email = cleanText(link.recipientEmail || link.firebaseEmail || "", 240).toLowerCase();
    const uidCandidates = [
      cleanText(link.firebaseUid || link.uid || "", 160),
      email,
    ].filter(Boolean);
    if (!email || !uidCandidates.length) continue;
    for (const ownerUid of uidCandidates) {
      owners.set(ownerUid, {
        uid: ownerUid,
        relation: "slack_email_import",
        scope: "layover_only",
        displayName: link.firebaseDisplayName || email,
        email,
      });
    }
  }

  return [...owners.values()];
}

async function sharedOwnersFor(uid, command = {}) {
  const owners = new Map();
  owners.set(uid, { uid, relation: "self", scope: "full", ...(await publicUser(uid)) });

  const shares = await db()
    .collection(SHARE_COLLECTION)
    .where("sharedWithUid", "==", uid)
    .get();

  for (const doc of shares.docs) {
    const share = doc.data();
    if (share.status !== "active" || !share.ownerUid) continue;
    owners.set(share.ownerUid, {
      uid: share.ownerUid,
      relation: "shared",
      scope: share.scope || "layover_only",
      displayName: share.ownerDisplayName || "",
      email: share.ownerEmail || "",
    });
  }

  for (const owner of await emailImportOwnersForSlackTeam(command)) {
    if (!owners.has(owner.uid)) owners.set(owner.uid, owner);
  }

  return [...owners.values()];
}

function rosterItem(doc, owner) {
  const data = doc.data();
  const activity = cleanText(data.Activity, 80);
  const crewArray = Array.isArray(data.CrewArray)
    ? data.CrewArray.map((name) => cleanText(name, 40)).filter(Boolean)
    : [];
  return {
    ownerUid: data.owner || owner.uid,
    crewName: owner.displayName || data.ownerDisplayName || "",
    date: cleanText(data.Date, 20),
    activity,
    from: upper(data.From),
    to: upper(data.To),
    stdl: cleanText(data.STDL || data["STD(L)"], 20),
    stal: cleanText(data.STAL || data["STA(L)"], 20),
    crewArray,
    type: isOffDuty(activity) ? "day_off" : "flight",
  };
}


async function rosterDocsForOwner(collectionName, ownerUid) {
  const docs = [];

  const flatSnapshot = await db()
    .collection(collectionName)
    .where("owner", "==", ownerUid)
    .get();

  docs.push(...flatSnapshot.docs);

  if (collectionName === PDC_COLLECTION) {
    const nestedSnapshot = await db()
      .collection(PDC_COLLECTION)
      .doc(ownerPdcDocId(ownerUid))
      .collection("events")
      .get();

    docs.push(...nestedSnapshot.docs);
  }

  return docs;
}

async function layoverItemsFor(uid, { station, startDate, days }, command = {}) {
  const endDate = addDays(startDate, days - 1);
  const startKey = dateSortKey(startDate);
  const endKey = dateSortKey(endDate);
  const owners = await sharedOwnersFor(uid, command);
  const nested = await Promise.all(
    owners.flatMap((owner) =>
      SHARE_ROSTER_COLLECTIONS.map(async (collectionName) => {
        const docs = await rosterDocsForOwner(collectionName, owner.uid);
        return docs
          .map((doc) => rosterItem(doc, owner))
          .filter((item) => item.type === "flight")
          .filter((item) => {
            const key = dateSortKey(item.date);
            return key >= startKey && key <= endKey;
          })
          .filter((item) => !station || item.from === station || item.to === station);
      })
    )
  );
  return dedupeRosterItems(nested.flat(), { ignoreTimes: true }).sort((a, b) => {
    const left = `${dateSortKey(a.date)}_${a.stdl}_${a.crewName}_${a.activity}`;
    const right = `${dateSortKey(b.date)}_${b.stdl}_${b.crewName}_${b.activity}`;
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

function dedupeNearDuplicateRosterItems(items) {
  const groups = [];
  for (const item of items) {
    const group = groups.find((existing) => looksLikeSameRosterItem(existing[0], item));
    if (group) {
      group.push(item);
    } else {
      groups.push([item]);
    }
  }
  return groups.map((group) => group.reduce(preferredRosterItem, null));
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
  const nested = await Promise.all(
    SHARE_ROSTER_COLLECTIONS.map(async (collectionName) => {
      const docs = await rosterDocsForOwner(collectionName, uid);
      return docs
        .map((doc) => rosterItem(doc, owner))
        .filter((item) => item.date && item.activity)
        .filter((item) => {
          const key = dateSortKey(item.date);
          return key >= startKey && key <= endKey;
        })
        .filter((item) => !station || item.from === station || item.to === station);
    })
  );
  return dedupeRosterItems(nested.flat(), { ignoreTimes: true }).sort((a, b) => {
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
    "`/my-roster` - show only your roster for today + 30 days",
    "`/my-roster HNL 2026-07-22 14` - show only your roster with optional station/date/days",
    "`/perdiem-report` - show your monthly PerDiem report in Slack",
    "`/perdiem-report user@example.com jul` - show that user's July PerDiem report",
    "`/perdiem-report set-email user@example.com` - save your default PerDiem report owner email",
    "`/layover HNL` - show shared HNL crew for today + 30 days",
    "`/layover HNL 2026-07-22 14` - choose start date and days",
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
  return {
    response_type: "ephemeral",
    text: `Roster iCal import complete. Rewrote pdc for this owner: saved ${result.imported} event(s), removed ${result.deleted} previous owner event(s), skipped ${result.skippedDuplicates} duplicate event(s).`,
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

function rosterLine(item, { includeName = false } = {}) {
  const route = [item.from, item.to].filter(Boolean).join("-");
  const time = item.stdl || item.stal || "";
  const name = includeName ? `${item.crewName || item.ownerUid}: ` : "";
  const crew = item.crewArray?.length ? ` | Crew: ${item.crewArray.join(", ")}` : "";
  return `- ${item.date} ${time} ${name}${item.activity} ${route}${crew}`.trim();
}

function layoverResponseText({ station, startDate, days, items }) {
  if (!station) return "Usage: `/layover HNL` or `/layover HNL 2026-07-22 14`";
  if (!items.length) {
    return `No shared crew found for ${station} from ${startDate} for ${days} day(s).`;
  }

  const lines = items.slice(0, 30).map((item) => {
    return rosterLine(item, { includeName: true });
  });
  const suffix = items.length > 30 ? `\n…and ${items.length - 30} more` : "";
  return `*${station} shared layover crew* (${startDate}, ${days} day(s))\n${lines.join("\n")}${suffix}`;
}

function myRosterResponseText({ station, startDate, days, items }) {
  const stationText = station ? ` ${station}` : "";
  if (!items.length) {
    return `No personal roster found${stationText} from ${startDate} for ${days} day(s).`;
  }

  const lines = items.slice(0, 40).map((item) => rosterLine(item));
  const suffix = items.length > 40 ? `\n…and ${items.length - 40} more` : "";
  return `*My roster${stationText}* (${startDate}, ${days} day(s))\n${lines.join("\n")}${suffix}`;
}

async function handleLayover(command) {
  const firebaseUid = await linkedFirebaseUid(command);
  if (!firebaseUid) {
    return { response_type: "ephemeral", text: notLinkedText(command) };
  }

  const parsed = parseLayoverText(command.text);
  const items = await layoverItemsFor(firebaseUid, parsed, command);
  return {
    response_type: "ephemeral",
    text: layoverResponseText({ ...parsed, items }),
  };
}

async function handleMyRoster(command) {
  const firebaseUid = await linkedFirebaseUid(command, { allowDefault: false });
  if (!firebaseUid) {
    return {
      response_type: "ephemeral",
      text: `${notLinkedText(command)}\n\nUse \`/roster-share link-me\` first, then run \`/my-roster\`.`,
    };
  }

  const parsed = parseMyRosterText(command.text);
  const items = await myRosterItemsFor(firebaseUid, parsed);
  return {
    response_type: "ephemeral",
    text: myRosterResponseText({ ...parsed, items }),
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

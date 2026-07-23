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
} from "./_shareUtils.mjs";

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

async function linkedFirebaseUid(command, { allowDefault = true } = {}) {
  const snap = await db()
    .collection(SLACK_LINK_COLLECTION)
    .doc(slackLinkId(command.teamId, command.userId))
    .get();
  if (snap.exists) {
    const data = snap.data();
    const linkedUid = cleanText(data.firebaseUid || data.uid || "", 160);
    if (linkedUid && data.status !== "disabled") return linkedUid;
  }

  if (!allowDefault) return "";

  const configuredUid = cleanText(process.env.SLACK_DEFAULT_FIREBASE_UID || "", 160);
  return configuredUid;
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

function mailInviteUrl({ inviteUrl: url, ownerName = "", recipientEmail = "" }) {
  const owner = cleanText(ownerName || "Roster Share", 120);
  const subject = "Roster Share 참여 링크";
  const statusUrl = `${url}${url.includes("?") ? "&" : "?"}mode=status`;
  const body = [
    url,
    "",
    statusUrl,
    "",
    `${owner} 님이 Roster Share에 초대했습니다.`,
    "",
    "첫 번째 URL: 수락하기",
    "두 번째 URL: 수락 여부 확인",
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

function inviteShareText(url) {
  const statusUrl = `${url}${url.includes("?") ? "&" : "?"}mode=status`;
  return [
    url,
    "",
    statusUrl,
    "",
    "첫 번째 URL: 수락하기",
    "두 번째 URL: 수락 여부 확인",
  ].join("\n");
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value, 240));
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
  return {
    date: `${match[1]}.${match[2]}.${match[3]}`,
    time: match[4] ? `${match[4]}:${match[5]}` : "",
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
  const start = parseIcsDate(event.DTSTART?.value || "");
  const end = parseIcsDate(event.DTEND?.value || "");
  const route = firstRoute(`${summary}\n${description}\n${location}`);
  const activity = activityFromIcs(summary, description);
  if (!start.date || !activity) return null;

  const uid = cleanText(event.UID?.value || hashText(`${summary}_${description}_${start.date}_${start.time}`), 200);
  const year = start.date.slice(0, 4);
  const month = Number.parseInt(start.date.slice(5, 7), 10);
  const { crew, crewArray } = crewFromIcsDescription(description);

  return {
    owner: owner.uid,
    uid: owner.uid,
    Date: start.date,
    DateRaw: start.date,
    Activity: activity,
    From: route.from,
    To: route.to,
    STDL: start.time,
    STAL: end.time,
    STDZ: "",
    STAZ: "",
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
    email: owner.email || "",
    source: SLACK_ICAL_SOURCE,
    sourceUidHash: hashText(uid),
    sourceSummary: summary,
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
  let deleted = 0;
  let imported = 0;

  for (const docData of docs) {
    const querySnapshot = await db()
      .collection(PDC_COLLECTION)
      .where("owner", "==", docData.owner)
      .where("Date", "==", docData.Date)
      .where("DC", "==", docData.DC)
      .where("Activity", "==", docData.Activity)
      .where("From", "==", docData.From)
      .where("To", "==", docData.To)
      .get();

    if (!querySnapshot.empty) {
      const batch = db().batch();
      for (const duplicate of querySnapshot.docs) {
        batch.delete(duplicate.ref);
        deleted += 1;
      }
      await batch.commit();
    }

    await db().collection(PDC_COLLECTION).add(docData);
    imported += 1;
  }

  return { deleted, imported };
}

function isOffDuty(activity) {
  return /^(REST|OFF|OFFD|DAY OFF|DO|VAC|LEAVE|RSV)$/i.test(cleanText(activity, 40));
}

async function sharedOwnersFor(uid) {
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

  return [...owners.values()];
}

function rosterItem(doc, owner) {
  const data = doc.data();
  const activity = cleanText(data.Activity, 80);
  return {
    ownerUid: data.owner || owner.uid,
    crewName: owner.displayName || data.ownerDisplayName || "",
    date: cleanText(data.Date, 20),
    activity,
    from: upper(data.From),
    to: upper(data.To),
    stdl: cleanText(data.STDL || data["STD(L)"], 20),
    stal: cleanText(data.STAL || data["STA(L)"], 20),
    type: isOffDuty(activity) ? "day_off" : "flight",
  };
}

async function layoverItemsFor(uid, { station, startDate, days }) {
  const endDate = addDays(startDate, days - 1);
  const startKey = dateSortKey(startDate);
  const endKey = dateSortKey(endDate);
  const owners = await sharedOwnersFor(uid);
  const nested = await Promise.all(
    owners.flatMap((owner) =>
      SHARE_ROSTER_COLLECTIONS.map(async (collectionName) => {
        const snap = await db().collection(collectionName).where("owner", "==", owner.uid).get();
        return snap.docs
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
  return nested.flat().sort((a, b) => {
    const left = `${dateSortKey(a.date)}_${a.stdl}_${a.crewName}_${a.activity}`;
    const right = `${dateSortKey(b.date)}_${b.stdl}_${b.crewName}_${b.activity}`;
    return left.localeCompare(right);
  });
}

function helpText() {
  return [
    "*Roster Slack commands*",
    "`/roster-share` - create a Roster Share invite link",
    "`/roster-share friend@example.com` - create an invite link with an email-compose button",
    "`/roster-share import webcal://...` - import your personal iCal roster privately",
    "`/layover HNL` - show shared HNL crew for today + 7 days",
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
  const isImportAction = ["import", "sync", "link", "ical", "webcal"].includes(action);
  const firebaseUid = await linkedFirebaseUid(command, { allowDefault: !isImportAction });
  if (!firebaseUid) {
    return {
      response_type: "ephemeral",
      text: isImportAction
        ? `${notLinkedText(command)}\n\nRoster iCal import requires a personal Slack-to-Firebase link so each friend's roster is saved under the correct owner.`
        : notLinkedText(command),
    };
  }

  if (isImportAction) {
    return handleRosterImport(command, firebaseUid);
  }

  const recipientEmail = looksLikeEmail(args[0]) ? cleanText(args[0], 240) : "";
  const scopeArgIndex = recipientEmail ? 1 : 0;
  const scope = cleanText(args[scopeArgIndex] || "layover_only", 40) || "layover_only";
  const invite = await createInviteForUid(firebaseUid, {
    scope,
    note: `Created from Slack ${command.teamDomain || command.teamId} #${command.channelName || command.channelId}`,
  });
  const shareText = inviteShareText(invite.inviteUrl);
  const mailUrl = mailInviteUrl({
    inviteUrl: invite.inviteUrl,
    ownerName: invite.owner.displayName || invite.owner.email || command.userName,
    recipientEmail,
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
        ],
      },
    ],
  };
}

async function handleRosterImport(command, firebaseUid) {
  const calendarUrl = extractRosterCalendarUrl(command.text);
  if (!calendarUrl) {
    return {
      response_type: "ephemeral",
      text: "Usage: `/roster-share import webcal://...`",
    };
  }

  const owner = await publicUser(firebaseUid);
  const dispatch = await dispatchIcalImportWorkflow({ calendarUrl, firebaseUid, owner });
  if (dispatch.dispatched) {
    return {
      response_type: "ephemeral",
      text: `Roster iCal import workflow queued: ${dispatch.actionsUrl}`,
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
    text: `Roster iCal import complete. Saved ${result.imported} event(s) to pdc, removed ${result.deleted} duplicate event(s).`,
  };
}

function parseLayoverText(text) {
  const parts = cleanText(text, 200).split(/\s+/).filter(Boolean);
  const station = upper(parts[0] || "");
  const startDate = cleanDate(parts[1]) || todaySeoul();
  const days = Math.min(Math.max(Number.parseInt(parts[2] || "7", 10) || 7, 1), 21);
  return { station, startDate, days };
}

function layoverResponseText({ station, startDate, days, items }) {
  if (!station) return "Usage: `/layover HNL` or `/layover HNL 2026-07-22 14`";
  if (!items.length) {
    return `No shared crew found for ${station} from ${startDate} for ${days} day(s).`;
  }

  const lines = items.slice(0, 30).map((item) => {
    const route = [item.from, item.to].filter(Boolean).join("-");
    const time = item.stdl || item.stal || "";
    const name = item.crewName || item.ownerUid;
    return `- ${item.date} ${time} ${name}: ${item.activity} ${route}`.trim();
  });
  const suffix = items.length > 30 ? `\n…and ${items.length - 30} more` : "";
  return `*${station} shared layover crew* (${startDate}, ${days} day(s))\n${lines.join("\n")}${suffix}`;
}

async function handleLayover(command) {
  const firebaseUid = await linkedFirebaseUid(command);
  if (!firebaseUid) {
    return { response_type: "ephemeral", text: notLinkedText(command) };
  }

  const parsed = parseLayoverText(command.text);
  const items = await layoverItemsFor(firebaseUid, parsed);
  return {
    response_type: "ephemeral",
    text: layoverResponseText({ ...parsed, items }),
  };
}

async function handleCommand(command) {
  if (command.text === "help" || command.command === "/roster-help") {
    return { response_type: "ephemeral", text: helpText() };
  }
  if (command.command === "/roster-share") return handleRosterShare(command);
  if (command.command === "/layover") return handleLayover(command);
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

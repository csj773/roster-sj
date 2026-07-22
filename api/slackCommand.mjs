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
const SLACK_LINK_COLLECTION = "slack_user_links";
const SLACK_ICAL_SOURCE = "slack_ical";

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

async function linkedFirebaseUid(command) {
  const configuredUid = cleanText(process.env.SLACK_DEFAULT_FIREBASE_UID || "", 160);
  if (configuredUid) return configuredUid;

  const snap = await db()
    .collection(SLACK_LINK_COLLECTION)
    .doc(slackLinkId(command.teamId, command.userId))
    .get();
  if (!snap.exists) return "";
  const data = snap.data();
  return cleanText(data.firebaseUid || data.uid || "", 160);
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
  const text = cleanText(value, 500);
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
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
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
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: match[4] ? `${match[4]}:${match[5]}` : "",
  };
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

function icsEventToRosterDoc(event, ownerUid) {
  const summary = cleanText(event.SUMMARY?.value || "", 200);
  const description = cleanText(event.DESCRIPTION?.value || "", 1000);
  const location = cleanText(event.LOCATION?.value || "", 200);
  const start = parseIcsDate(event.DTSTART?.value || "");
  const end = parseIcsDate(event.DTEND?.value || "");
  const route = firstRoute(`${summary}\n${description}\n${location}`);
  const activity = activityFromIcs(summary, description);
  if (!start.date || !activity) return null;

  const uid = cleanText(event.UID?.value || hashText(`${summary}_${description}_${start.date}_${start.time}`), 200);
  const { Year, Month } = {
    Year: Number.parseInt(start.date.slice(0, 4), 10),
    Month: Number.parseInt(start.date.slice(5, 7), 10),
  };

  return {
    owner: ownerUid,
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
    Crew: "",
    CrewArray: [],
    Year,
    Month,
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

async function replaceImportedRoster(uid, docs) {
  const existing = await db()
    .collection(ROSTER_COLLECTION)
    .where("owner", "==", uid)
    .where("source", "==", SLACK_ICAL_SOURCE)
    .get();

  const writes = [
    ...existing.docs.map((doc) => ({ type: "delete", ref: doc.ref })),
    ...docs.map((doc) => {
      const id = `${uid}_${SLACK_ICAL_SOURCE}_${doc.Date}_${doc.sourceUidHash}`.replace(/[^A-Za-z0-9_-]/g, "_");
      return {
        type: "set",
        ref: db().collection(ROSTER_COLLECTION).doc(id),
        data: doc,
      };
    }),
  ];

  for (let i = 0; i < writes.length; i += 450) {
    const batch = db().batch();
    for (const write of writes.slice(i, i + 450)) {
      if (write.type === "delete") batch.delete(write.ref);
      if (write.type === "set") batch.set(write.ref, write.data, { merge: true });
    }
    await batch.commit();
  }
  return { deleted: existing.size, imported: docs.length };
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
  const owners = await sharedOwnersFor(uid);
  const nested = await Promise.all(owners.map(async (owner) => {
    const snap = await db().collection(ROSTER_COLLECTION).where("owner", "==", owner.uid).get();
    return snap.docs
      .map((doc) => rosterItem(doc, owner))
      .filter((item) => item.type === "flight")
      .filter((item) => item.date >= startDate && item.date <= endDate)
      .filter((item) => !station || item.from === station || item.to === station);
  }));
  return nested.flat().sort((a, b) => {
    const left = `${a.date}_${a.stdl}_${a.crewName}_${a.activity}`;
    const right = `${b.date}_${b.stdl}_${b.crewName}_${b.activity}`;
    return left.localeCompare(right);
  });
}

function helpText() {
  return [
    "*Roster Slack commands*",
    "`/roster-share` - create a Roster Share invite link",
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
  const firebaseUid = await linkedFirebaseUid(command);
  if (!firebaseUid) {
    return { response_type: "ephemeral", text: notLinkedText(command) };
  }

  const args = parseSlackArgs(command.text);
  const action = cleanText(args[0] || "", 40).toLowerCase();
  if (["import", "sync", "link", "ical", "webcal"].includes(action)) {
    return handleRosterImport(command, firebaseUid);
  }

  const scope = cleanText(args[0] || "layover_only", 40) || "layover_only";
  const invite = await createInviteForUid(firebaseUid, {
    scope,
    note: `Created from Slack ${command.teamDomain || command.teamId} #${command.channelName || command.channelId}`,
  });

  return {
    response_type: "ephemeral",
    text: `Roster Share invite created: ${invite.inviteUrl}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Roster Share invite created*\nScope: \`${scope}\`\n${invite.inviteUrl}`,
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

  const ics = await fetchIcsCalendar(calendarUrl);
  const docs = parseIcsEvents(ics)
    .map((event) => icsEventToRosterDoc(event, firebaseUid))
    .filter(Boolean);

  if (!docs.length) {
    return {
      response_type: "ephemeral",
      text: "iCal calendar was fetched, but no roster events were found.",
    };
  }

  const result = await replaceImportedRoster(firebaseUid, docs);
  return {
    response_type: "ephemeral",
    text: `Roster iCal import complete. Imported ${result.imported} event(s), replaced ${result.deleted} old imported event(s).`,
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

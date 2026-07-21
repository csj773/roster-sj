// ==================== kakaoCiReminder.js ====================
import admin from "firebase-admin";
import process from "process";

const KAKAO_API_BASE = "https://kapi.kakao.com";
let kakaoAccessToken = process.env.KAKAO_CALENDAR_ACCESS_TOKEN || process.env.KAKAO_ACCESS_TOKEN || "";
const KAKAO_REFRESH_TOKEN = process.env.KAKAO_REFRESH_TOKEN || "";
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY || "";
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET || "";
const ROSTER_COLLECTION = process.env.INPUT_FIRESTORE_COLLECTION || "roster";
const REMINDER_COLLECTION = process.env.KAKAO_CI_REMINDER_COLLECTION || "kakao_ci_reminders";
const REMINDER_MINUTES_BEFORE = Number(process.env.KAKAO_CI_REMINDER_MINUTES_BEFORE || 180);
const REMINDER_WINDOW_MINUTES = Number(process.env.KAKAO_CI_REMINDER_WINDOW_MINUTES || 15);
const DRY_RUN = process.env.KAKAO_CI_REMINDER_DRY_RUN === "1";

const AIRPORT_TIMEZONES = {
  ICN: "Asia/Seoul",
  LAX: "America/Los_Angeles",
  SFO: "America/Los_Angeles",
  EWR: "America/New_York",
  NRT: "Asia/Tokyo",
  HKG: "Asia/Hong_Kong",
  DAC: "Asia/Dhaka",
  HNL: "Pacific/Honolulu",
  ESB: "Europe/Istanbul",
  BKK: "Asia/Bangkok",
};

function serviceAccountJson() {
  const raw =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    "";
  const b64 =
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64 ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 ||
    "";
  const value = raw || (b64 ? Buffer.from(b64, "base64").toString("utf8") : "");
  if (!value) throw new Error("Firebase service account is not configured");

  const parsed = JSON.parse(value.replace(/^\uFEFF/, ""));
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

function initializeFirebaseAdmin() {
  if (admin.apps.length) return;
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson()),
  });
}

function getTimeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return zonedAsUtc - date.getTime();
}

function parseHHMMOffset(str, baseDateStr, airport) {
  if (!str) return null;
  const match = String(str).trim().match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const tz = AIRPORT_TIMEZONES[String(airport || "").trim().toUpperCase()] || AIRPORT_TIMEZONES.ICN;
  const [year, month, day] = String(baseDateStr || "").split("-").map(Number);
  if (!year || !month || !day) return null;

  const dayOffset = offset ? Number(offset) : 0;
  const localWallTimeAsUtc = Date.UTC(year, month - 1, day + dayOffset, Number(hh), Number(mm));
  const firstGuess = new Date(localWallTimeAsUtc);
  let offsetMs = getTimeZoneOffsetMs(firstGuess, tz);
  let utcTime = new Date(localWallTimeAsUtc - offsetMs);
  offsetMs = getTimeZoneOffsetMs(utcTime, tz);
  utcTime = new Date(localWallTimeAsUtc - offsetMs);
  return utcTime;
}

function todayYmdInSeoul(deltaDays = 0) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now.getTime() + deltaDays * 24 * 60 * 60 * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function clean(value) {
  return String(value || "").trim();
}

function eventKey(doc) {
  return [
    clean(doc.owner || doc.uid),
    clean(doc.Date),
    clean(doc.CIL || doc["C/I(L)"]),
    clean(doc.Activity),
    clean(doc.From),
    clean(doc.To),
    clean(doc.STDL || doc["STD(L)"]),
  ].join("|").replace(/[^\w|.-]/g, "_");
}

function shouldSkip(doc) {
  const activity = clean(doc.Activity).toUpperCase();
  const ci = clean(doc.CIL || doc["C/I(L)"]);
  if (!activity) return true;
  if (/REST|OFF|ETC/i.test(activity)) return true;
  if (!ci || ci === "0000") return true;
  return false;
}

function formatKst(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function buildMessage(doc, ciTime) {
  const activity = clean(doc.Activity);
  const from = clean(doc.From);
  const to = clean(doc.To);
  const ci = clean(doc.CIL || doc["C/I(L)"]);
  const std = clean(doc.STDL || doc["STD(L)"]);
  const crew = clean(doc.Crew);
  return [
    `[Roster 알림] C/I 3시간 전`,
    `${activity} ${from}${to ? ` -> ${to}` : ""}`,
    `C/I(L): ${ci} (${formatKst(ciTime)} KST)`,
    std ? `STD(L): ${std}` : "",
    crew ? `Crew: ${crew}` : "",
  ].filter(Boolean).join("\n");
}

async function refreshKakaoAccessToken() {
  if (kakaoAccessToken) return;
  if (!KAKAO_REFRESH_TOKEN || !KAKAO_REST_API_KEY) {
    throw new Error("KAKAO_REFRESH_TOKEN and KAKAO_REST_API_KEY are required");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: KAKAO_REST_API_KEY,
    refresh_token: KAKAO_REFRESH_TOKEN,
  });
  if (KAKAO_CLIENT_SECRET) body.set("client_secret", KAKAO_CLIENT_SECRET);

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
    const error = new Error(`Kakao access token 갱신 실패 (${response.status})`);
    error.body = data;
    throw error;
  }
  if (!data.access_token) throw new Error("Kakao token response did not include access_token");
  kakaoAccessToken = data.access_token;
  if (data.refresh_token) {
    console.log("⚠️ Kakao가 새 refresh_token을 발급했습니다. GitHub Secret KAKAO_REFRESH_TOKEN을 새 값으로 교체해야 합니다.");
  }
}

async function sendKakaoMemo(text) {
  const templateObject = {
    object_type: "text",
    text,
    link: {
      web_url: "https://logbook-tljs60.flutterflow.app",
      mobile_web_url: "https://logbook-tljs60.flutterflow.app",
    },
    button_title: "Roster 보기",
  };

  const response = await fetch(`${KAKAO_API_BASE}/v2/api/talk/memo/default/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kakaoAccessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body: new URLSearchParams({
      template_object: JSON.stringify(templateObject),
    }),
  });

  const responseText = await response.text();
  const data = responseText ? JSON.parse(responseText) : {};
  if (!response.ok) {
    const error = new Error(`Kakao memo send failed (${response.status})`);
    error.body = data;
    throw error;
  }
  return data;
}

async function loadCandidateRosterDocs(db, ownerUid) {
  const dateSet = new Set([
    todayYmdInSeoul(-1),
    todayYmdInSeoul(0),
    todayYmdInSeoul(1),
    todayYmdInSeoul(2),
  ]);

  const snapshot = await db.collection(ROSTER_COLLECTION).where("owner", "==", ownerUid).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((doc) => dateSet.has(clean(doc.Date)));
}

async function markSent(db, key, doc, reminderAt, ciTime) {
  await db.collection(REMINDER_COLLECTION).doc(key).set({
    key,
    owner: clean(doc.owner || doc.uid),
    rosterDocId: doc.id,
    activity: clean(doc.Activity),
    date: clean(doc.Date),
    from: clean(doc.From),
    to: clean(doc.To),
    ci: clean(doc.CIL || doc["C/I(L)"]),
    ciTime: ciTime.toISOString(),
    reminderAt: reminderAt.toISOString(),
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
}

(async () => {
  console.log("🚀 Kakao C/I reminder check 시작");
  initializeFirebaseAdmin();
  const db = admin.firestore();

  const ownerUid = clean(
    process.env.INPUT_FIREBASE_UID ||
      process.env.FIREBASE_UID ||
      process.env.FIRESTORE_ADMIN_UID ||
      process.env.INPUT_ADMIN_FIREBASE_UID
  );
  if (!ownerUid) throw new Error("FIREBASE_UID or FIRESTORE_ADMIN_UID is required");

  const now = new Date();
  const windowMs = REMINDER_WINDOW_MINUTES * 60 * 1000;
  const beforeMs = REMINDER_MINUTES_BEFORE * 60 * 1000;
  const docs = await loadCandidateRosterDocs(db, ownerUid);
  const due = [];

  for (const doc of docs) {
    if (shouldSkip(doc)) continue;
    const ciTime = parseHHMMOffset(doc.CIL || doc["C/I(L)"], doc.Date, doc.From);
    if (!ciTime) continue;
    const reminderAt = new Date(ciTime.getTime() - beforeMs);
    const ageMs = now.getTime() - reminderAt.getTime();
    if (ageMs < 0 || ageMs >= windowMs) continue;
    due.push({ doc, ciTime, reminderAt, key: eventKey(doc) });
  }

  console.log(`🔎 후보 ${docs.length}건, 발송 대상 ${due.length}건`);
  if (!due.length) return;

  await refreshKakaoAccessToken();

  let sent = 0;
  for (const item of due) {
    const sentRef = db.collection(REMINDER_COLLECTION).doc(item.key);
    const alreadySent = await sentRef.get();
    if (alreadySent.exists) {
      console.log(`⏭ 이미 발송됨: ${item.doc.Activity} ${item.doc.Date} ${item.doc.CIL || item.doc["C/I(L)"]}`);
      continue;
    }

    const message = buildMessage(item.doc, item.ciTime);
    if (DRY_RUN) {
      console.log(`🧪 DRY_RUN 발송 예정: ${message.replace(/\n/g, " | ")}`);
    } else {
      await sendKakaoMemo(message);
      await markSent(db, item.key, item.doc, item.reminderAt, item.ciTime);
      console.log(`✅ Kakao 나에게 톡 발송: ${item.doc.Activity} ${item.doc.Date} ${item.doc.CIL || item.doc["C/I(L)"]}`);
    }
    sent += 1;
  }

  console.log(`✅ Kakao C/I reminder check 완료: ${sent}건 처리`);
})().catch((error) => {
  console.error("❌ Kakao C/I reminder 실패:", error.message);
  if (error.body) console.error(JSON.stringify(error.body));
  process.exit(1);
});

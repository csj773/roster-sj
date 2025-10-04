// ==================== gcal.js 10.13 ====================
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import process from "process";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) {
  console.error(" GOOGLE_CALENDAR_ID 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
if (!GOOGLE_CALENDAR_CREDENTIALS) {
  console.error(" GOOGLE_CALENDAR_CREDENTIALS 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

let creds;
try {
  creds = GOOGLE_CALENDAR_CREDENTIALS.trim().startsWith("{")
    ? JSON.parse(GOOGLE_CALENDAR_CREDENTIALS)
    : JSON.parse(fs.readFileSync(GOOGLE_CALENDAR_CREDENTIALS, "utf-8"));
} catch (e) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 파싱 실패:", e.message);
  process.exit(1);
}

// ------------------- 공항 UTC 오프셋 -------------------
const AIRPORT_OFFSETS = { ICN: 9, LAX: -7, SFO: -7, EWR: -4, NRT: 9, HKG: 8, DAC: 6 };

// ------------------- 유틸 함수 -------------------
function parseTimeStr(t) {
  if (!t) return null;
  const m = t.trim().match(/^(\d{1,2}):?(\d{2})?$/);
  if (!m) return null;
  return { hour: parseInt(m[1], 10), minute: m[2] ? parseInt(m[2], 10) : 0 };
}

function parseBLHtoMinutes(blh) {
  if (!blh) return 0;
  const m = blh.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function localToUTCms({ year, month, day, hour, minute }, airport) {
  const offset = AIRPORT_OFFSETS[airport] ?? AIRPORT_OFFSETS["ICN"];
  return Date.UTC(year, month - 1, day, hour - offset, minute || 0, 0, 0);
}

function getSystemOffsetMs() {
  return -new Date().getTimezoneOffset() * 60 * 1000;
}

function toISOLocalString(d) {
  const pad = (n) => (n < 10 ? "0" + n : n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function parseRosterDate(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/\d{1,2}/);
  if (!m) return null;
  const day = parseInt(m[0], 10);
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  if (day < now.getDate() - 15) month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return { year, month, day };
}

// ------------------- Google Calendar 초기화 -------------------
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/calendar"] });
const calendar = google.calendar({ version: "v3", auth });

// ------------------- 기존 gcal.js 이벤트 삭제 -------------------
async function deleteExistingGcalEvents() {
  console.log("🗑 기존 gcal.js 이벤트 삭제 시작...");
  let pageToken;
  do {
    const eventsRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      singleEvents: true,
      orderBy: "startTime",
      pageToken,
    });
    const events = eventsRes.data.items || [];
    for (const ev of events) {
      const evDesc = ev.description || "";
      if (evDesc.includes("CREATED_BY_GCALJS")) {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ev.id });
        console.log(`🗑 삭제: ${ev.summary}`);
      }
    }
    pageToken = eventsRes.data.nextPageToken;
  } while (pageToken);
  console.log("✅ 기존 gcal.js 이벤트 삭제 완료");
}

// ------------------- 메인 -------------------
(async () => {
  console.log("🚀 Google Calendar 업로드 시작");

  await deleteExistingGcalEvents();

  const rosterPath = path.join(process.cwd(), "public", "roster.json");
  if (!fs.existsSync(rosterPath)) {
    console.error("❌ roster.json 없음");
    process.exit(1);
  }

  const rosterRaw = JSON.parse(fs.readFileSync(rosterPath, "utf-8"));
  const values = rosterRaw.values;
  if (!Array.isArray(values) || values.length < 2) {
    console.error("❌ 데이터 없음");
    process.exit(1);
  }

  const headers = values[0];
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const activity = row[idx["Activity"]];
    if (!activity || !activity.trim()) continue;

    const { year, month, day } = parseRosterDate(row[idx["Date"]]);
    const from = row[idx["From"]] || "ICN";
    const to = row[idx["To"]] || "";

    const ci = parseTimeStr(row[idx["C/I(L)"]]) || parseTimeStr(row[idx["STD(L)"]]);
    const co = parseTimeStr(row[idx["C/O(L)"]]) || parseTimeStr(row[idx["STA(L)"]]);

    if (!ci || !co) {
      console.warn(`⚠️ CI(L)/CO(L) 시간 누락: ${activity} (행 ${r})`);
      continue;
    }

    const std = row[idx["STD(L)"]] || "00:00";
    const sta = row[idx["STA(L)"]] || "00:00";
    const blh = row[idx["BLH"]] || "00:00";
    const acReg = row[idx["AcReg"]] || "";
    const crew = row[idx["Crew"]] || "";
    const notes = row[idx["Notes"]] || "";

    const startUtcMs = localToUTCms({ year, month, day, hour: ci.hour, minute: ci.minute }, from);
    const endUtcMs = localToUTCms({ year, month, day, hour: co.hour, minute: co.minute }, to);

    const sysOffset = getSystemOffsetMs();
    const startLocal = new Date(startUtcMs + sysOffset);
    const endLocal = new Date(endUtcMs + sysOffset);

    const description = `
CREATED_BY_GCALJS
Activity: ${activity}
STD(L): ${std} | STA(L): ${sta}
Crew Notes: ${notes}
Blockhours: ${blh}
AcReg: ${acReg}

Local Start: ${toISOLocalString(startLocal)}
UTC Start: ${new Date(startUtcMs).toISOString()}
Local End: ${toISOLocalString(endLocal)}
UTC End: ${new Date(endUtcMs).toISOString()}
Crew: ${crew}
`.trim();

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: activity,
        location: `${from} → ${to}`,
        description,
        start: { dateTime: toISOLocalString(startLocal), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end: { dateTime: toISOLocalString(endLocal), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      }
    });

    console.log(`✅ 추가: ${activity} (${from}→${to}) [${toISOLocalString(startLocal)}]`);
  }

  console.log("✅ Google Calendar 업로드 완료");
})();
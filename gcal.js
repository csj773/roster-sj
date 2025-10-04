// ==================== gcal.js 10.6 ====================
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import process from "process";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) {
  console.error("❌ GOOGLE_CALENDAR_ID 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
if (!GOOGLE_CALENDAR_CREDENTIALS) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 필요 (GitHub Secrets에 등록)");
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
  if (!blh) return null;
  const m = blh.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// UTC + airport offset + rollover(+1/+2) 처리
function parseSTDWithRollover(stdStr, dayRollover, airport) {
  const t = parseTimeStr(stdStr);
  if (!t) return null;
  const offset = AIRPORT_OFFSETS[airport] ?? AIRPORT_OFFSETS["ICN"];
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate(); // 임시 day, 실제는 roster 날짜로 교체
  // UTC milliseconds 계산
  return Date.UTC(year, month - 1, day + dayRollover, t.hour - offset, t.minute, 0, 0);
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
  if (month > 12) { month = 1; year += 1; }
  return { year, month, day };
}

// ------------------- Google Calendar 초기화 -------------------
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/calendar"] });
const calendar = google.calendar({ version: "v3", auth });

// ------------------- 메인 -------------------
(async () => {
  console.log("🚀 Google Calendar 업로드 시작");

  const rosterPath = path.join(process.cwd(), "public", "roster.json");
  if (!fs.existsSync(rosterPath)) { console.error("❌ roster.json 없음"); process.exit(1); }

  const rosterRaw = JSON.parse(fs.readFileSync(rosterPath, "utf-8"));
  const values = rosterRaw.values;
  if (!Array.isArray(values) || values.length < 2) { console.error("❌ 데이터 없음"); process.exit(1); }

  const headers = values[0];
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const activity = row[idx["Activity"]];
    if (!activity || !activity.trim()) continue;

    const rosterDate = parseRosterDate(row[idx["Date"]]);
    if (!rosterDate) continue;
    const { year, month, day } = rosterDate;

    const from = row[idx["From"]] || "ICN";
    const to = row[idx["To"]] || "";
    const std = parseTimeStr(row[idx["STD(L)"]]) || parseTimeStr(row[idx["STA(L)"]]);
    const blh = row[idx["BLH"]] || "";

    // All-day event
    if (/REST/i.test(activity) || !std) {
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: { summary: activity, start: { date: `${year}-${month}-${day}` }, end: { date: `${year}-${month}-${day}` }, description: `Crew:${row[idx["Crew"]]}` }
      });
      continue;
    }

    // Normal timed event
    let dayRollover = 0;
    if (/\+(\d)/.test(row[idx["STD(Z)"]])) {
      dayRollover = parseInt(row[idx["STD(Z)"]].match(/\+(\d)/)[1], 10);
    }
    const startUtcMs = localToUTCms({ year, month, day, hour: std.hour, minute: std.minute }, from) + dayRollover * 24 * 60 * 60 * 1000;
    const durationMin = parseBLHtoMinutes(blh) || 120;
    const endUtcMs = startUtcMs + durationMin * 60 * 1000;

    const sysOffset = getSystemOffsetMs();
    const startLocal = new Date(startUtcMs + sysOffset);
    const endLocal = new Date(endUtcMs + sysOffset);

    // 중복 제거
    const startDay = new Date(startLocal); startDay.setHours(0,0,0,0);
    const endDay = new Date(startLocal); endDay.setHours(23,59,59,999);
    const existing = (await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startDay.toISOString(),
      timeMax: endDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    })).data.items || [];

    for (const ex of existing) {
      const exStartMs = ex.start.dateTime ? new Date(ex.start.dateTime).getTime() : new Date(ex.start.date + "T00:00:00").getTime();
      if (ex.summary === activity && exStartMs === startLocal.getTime()) {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ex.id });
      }
    }

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: activity,
        location: from + " → " + to,
        description: `AcReg:${row[idx["AcReg"]]} BLH:${blh} From:${from} To:${to}`,
        start: { dateTime: toISOLocalString(startLocal), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end: { dateTime: toISOLocalString(endLocal), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      }
    });
  }

  console.log("✅ Google Calendar 업로드 완료");
})();








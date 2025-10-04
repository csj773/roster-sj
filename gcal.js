// ==================== gcal.js (STD/STA/CI Local version) ====================
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import process from "process";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) {
  console.error("❌ GOOGLE_CALENDAR_ID 필요");
  process.exit(1);
}

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
if (!GOOGLE_CALENDAR_CREDENTIALS) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 필요");
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
const AIRPORT_OFFSETS = {
  ICN: 9,
  GMP: 9,
  CJU: 9,
  LAX: -7,
  SFO: -7,
  JFK: -4,
  EWR: -4,
  NRT: 9,
  HND: 9,
  HKG: 8,
  BKK: 7,
  SIN: 8,
  DAC: 6,
};

// ------------------- Date 변환 -------------------
function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return input;
  const now = new Date();
  const year = now.getFullYear();
  const monthMap = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
  };
  let month, dayStr;
  if (monthMap[parts[0]]) {
    month = monthMap[parts[0]];
    dayStr = parts[1].padStart(2, "0");
  } else {
    month = String(now.getMonth() + 1).padStart(2, "0");
    dayStr = parts[1].padStart(2, "0");
  }
  return `${year}-${month}-${dayStr}`;
}

// ------------------- HHMM ±offset → UTC Date 변환 -------------------
function parseLocalToUTC(hhmm, baseDateStr, airport) {
  if (!hhmm) return null;
  const match = hhmm.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const [year, month, day] = baseDateStr.split("-").map(Number);
  let d = new Date(Date.UTC(year, month - 1, day, Number(hh), Number(mm)));
  if (offset) d.setUTCDate(d.getUTCDate() + Number(offset));
  const localOffset = AIRPORT_OFFSETS[airport] ?? 9;
  d.setUTCHours(d.getUTCHours() - localOffset);
  return d;
}

// ------------------- Google Calendar 초기화 -------------------
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

// ------------------- 기존 이벤트 로드 -------------------
async function fetchExistingEvents() {
  console.log("📥 기존 이벤트 불러오기...");
  const events = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      singleEvents: true,
      orderBy: "startTime",
      timeMin: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      timeMax: new Date(Date.now() + 120 * 24 * 3600 * 1000).toISOString(),
      pageToken,
    });
    events.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  console.log(`✅ 기존 이벤트 ${events.length}건 로드됨`);
  return events;
}

// ------------------- 메인 -------------------
(async () => {
  console.log("🚀 Google Calendar 업로드 시작");

  const existing = await fetchExistingEvents();
  const rosterPath = path.join(process.cwd(), "public", "roster.json");

  if (!fs.existsSync(rosterPath)) {
    console.error("❌ roster.json 없음");
    process.exit(1);
  }

  const roster = JSON.parse(fs.readFileSync(rosterPath, "utf-8"));
  const values = roster.values;
  if (!Array.isArray(values) || values.length < 2) {
    console.error("❌ roster 데이터 없음");
    process.exit(1);
  }

  const headers = values[0];
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const activity = row[idx["Activity"]];
    if (!activity) continue;

    const rawDate = row[idx["Date"]];
    const convDate = convertDate(rawDate);
    const from = row[idx["From"]] || "ICN";
    const to = row[idx["To"]] || "";
    const ci = row[idx["C/I(L)"]];
    const std = row[idx["STD(L)"]];
    const sta = row[idx["STA(L)"]];
    const crew = row[idx["Crew"]] || "";

    const isAllDay = /REST|OFF|ETC/i.test(activity);
    const summaryBase = `${activity} ${from}→${to}`;

    if (isAllDay) {
      const dup = existing.find(ev => ev.summary === activity && ev.start?.date === convDate);
      if (dup) {
        console.log(`⚠️ 중복(ALL-DAY) 스킵: ${activity}`);
        continue;
      }
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: activity,
          start: { date: convDate },
          end: { date: convDate },
          description: `CREATED_BY_GCALJS\nCrew: ${crew}`,
        },
      });
      console.log(`✅ ALL-DAY 추가: ${activity}`);
      continue;
    }

    const startUTC = parseLocalToUTC(std, convDate, from);
    const endUTC = parseLocalToUTC(sta, convDate, to);
    const ciUTC = parseLocalToUTC(ci, convDate, from);

    if (!startUTC || !endUTC) continue;
    if (endUTC <= startUTC) endUTC.setUTCDate(endUTC.getUTCDate() + 1);

    const dupFlight = existing.find(ev =>
      ev.summary === summaryBase && ev.start?.dateTime === startUTC.toISOString()
    );
    if (dupFlight) {
      console.log(`⚠️ 중복(FLIGHT) 스킵: ${summaryBase}`);
      continue;
    }

    const description = `
CREATED_BY_GCALJS
Activity: ${activity}
Crew: ${crew}
From: ${from} To: ${to}
C/I(L): ${ci} STD(L): ${std} STA(L): ${sta}
`.trim();

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: summaryBase,
        location: `${from} → ${to}`,
        description,
        start: { dateTime: startUTC.toISOString(), timeZone: "UTC" },
        end: { dateTime: endUTC.toISOString(), timeZone: "UTC" },
      },
    });
    console.log(`✅ 비행 추가: ${summaryBase}`);

    // ------------------- Check-in 추가 -------------------
    if (ciUTC) {
      const checkSummary = `Check-in ${from} ${activity}`;
      const dupCheck = existing.find(
        ev => ev.summary === checkSummary && ev.start?.dateTime === ciUTC.toISOString()
      );
      if (!dupCheck) {
        await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: {
            summary: checkSummary,
            description: `CREATED_BY_GCALJS\n${activity} ${from}→${to}`,
            start: { dateTime: ciUTC.toISOString(), timeZone: "UTC" },
            end: { dateTime: startUTC.toISOString(), timeZone: "UTC" },
          },
        });
        console.log(`🕐 Check-in 추가: ${checkSummary}`);
      } else {
        console.log(`⚠️ 중복(Check-in) 스킵: ${checkSummary}`);
      }
    }
  }

  console.log("✅ Google Calendar 업로드 완료");
})();




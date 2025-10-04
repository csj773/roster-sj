import fs from "fs";
import { google } from "googleapis";
import process from "process";
import path from "path";

// ------------------- 환경변수 확인 -------------------
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;

if (!CALENDAR_ID) {
  console.error("❌ GOOGLE_CALENDAR_ID 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}
if (!GOOGLE_CALENDAR_CREDENTIALS) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

// ------------------- 서비스 계정 인증 -------------------
let creds;
try {
  creds = GOOGLE_CALENDAR_CREDENTIALS.trim().startsWith("{")
    ? JSON.parse(GOOGLE_CALENDAR_CREDENTIALS)
    : JSON.parse(fs.readFileSync(GOOGLE_CALENDAR_CREDENTIALS, "utf-8"));
} catch (e) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 파싱 실패:", e.message);
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

// ------------------- roster.json 읽기 -------------------
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

// ------------------- 헬퍼 함수 -------------------
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
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTime(t) {
  if (!t) return null;
  const [hour, minute] = t.split(":").map(n => parseInt(n, 10));
  return { hour, minute };
}

function parseBLHtoMinutes(blh) {
  if (!blh) return 120; // 기본 2시간
  const [h, m] = blh.split(":").map(n => parseInt(n, 10));
  return h * 60 + (m || 0);
}

// ------------------- Google Calendar 업로드 -------------------
(async () => {
  console.log("🚀 Google Calendar 업로드 시작");

  const headers = values[0];
  const idx = {};
  headers.forEach((h, i) => idx[h] = i);

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const activity = row[idx["Activity"]];
    if (!activity || !activity.trim()) continue;

    const isoDateStr = parseRosterDate(row[idx["Date"]]);
    if (!isoDateStr) continue;

    // All-day event (REST)
    if (/REST/i.test(activity)) {
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: activity,
          start: { date: isoDateStr },
          end: { date: isoDateStr },
          description: `Crew: ${row[idx["Crew"]]}`
        }
      });
      console.log(`✅ ALL-DAY 추가: ${activity} (${isoDateStr})`);
      continue;
    }

    // Check-In(STD) 기준 이벤트
    const stdStr = row[idx["STD(L)"]];
    if (!stdStr) {
      console.warn(`⚠️ STD 없음, 건너뜀: ${activity} (${isoDateStr})`);
      continue;
    }

    const stdTime = parseTime(stdStr);
    const blh = row[idx["BLH"]] || "2:00";
    const durationMin = parseBLHtoMinutes(blh);

    const start = new Date(`${isoDateStr}T${String(stdTime.hour).padStart(2,"0")}:${String(stdTime.minute).padStart(2,"0")}:00`);
    const end = new Date(start.getTime() + durationMin * 60000);

    // 기존 이벤트 중복 제거
    const existing = (await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime"
    })).data.items || [];

    for (const ex of existing) {
      if (ex.summary === activity) {
        await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ex.id });
        console.log(`🗑 삭제: ${ex.summary}`);
      }
    }

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: activity,
        location: `${row[idx["From"]]} → ${row[idx["To"]]}`,
        description: `AcReg: ${row[idx["AcReg"]]} BLH: ${blh} Check-In: ${stdStr}`,
        start: { dateTime: start.toISOString(), timeZone: "UTC" },
        end: { dateTime: end.toISOString(), timeZone: "UTC" }
      }
    });
    console.log(`✅ 추가: ${activity} (${row[idx["From"]]}→${row[idx["To"]]}) Check-In: ${stdStr}`);
  }

  console.log("✅ Google Calendar 업로드 완료");
})();







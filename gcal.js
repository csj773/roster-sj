// ==================== gcal.js ====================
import fs from "fs";
import path from "path";
import process from "process";
import { google } from "googleapis";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) {
  console.error("❌ GOOGLE_CALENDAR_ID 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
if (!GOOGLE_CALENDAR_CREDENTIALS) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

// ------------------- Google 인증 -------------------
const credentials = JSON.parse(GOOGLE_CALENDAR_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

// ------------------- 유틸 함수 -------------------
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function toISOLocalString(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}

// "HHMM" 또는 "HH:MM" → Date 객체
function parseLocal(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;

  const [yyyy, mm, dd] = dateStr.split("-").map(Number);

  let hour, minute;
  if (timeStr.includes(":")) {
    [hour, minute] = timeStr.split(":").map(Number);
  } else if (timeStr.length >= 3) {
    hour = Number(timeStr.slice(0, -2));
    minute = Number(timeStr.slice(-2));
  } else {
    hour = Number(timeStr);
    minute = 0;
  }

  return new Date(yyyy, mm - 1, dd, hour, minute);
}

// ------------------- 메인 함수 -------------------
async function main() {
  console.log("🚀 Google Calendar 업로드 시작");

  const rosterPath = path.join("public", "roster.json");
  if (!fs.existsSync(rosterPath)) {
    console.error("❌ roster.json 파일이 존재하지 않습니다.");
    process.exit(1);
  }

  const rosterJson = JSON.parse(fs.readFileSync(rosterPath, "utf-8"));
  const values = rosterJson.values;
  if (!Array.isArray(values) || values.length < 2) {
    console.error("❌ 유효한 데이터 없음");
    process.exit(1);
  }

  const headers = values[0].map((h) => h.trim());
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));

  const now = new Date();
  const future = new Date();
  future.setDate(now.getDate() + 30);

  const { data: existing } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });
  const existingEvents = existing.items || [];
  console.log(`📋 기존 일정 ${existingEvents.length}건 확인`);

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const date = row[idx["Date"]];
    const activity = row[idx["Activity"]];
    if (!activity || !date) continue;

    const from = row[idx["From"]] || "-";
    const to = row[idx["To"]] || "-";
    const std = row[idx["C/I(L)"]] || row[idx["STD(L)"]] || "0000";
    const sta = row[idx["C/O(L)"]] || row[idx["STA(L)"]] || "0100";
    const blh = row[idx["BLH"]] || "-";
    const acReg = row[idx["AcReg"]] || "-";
    const checkIn = row[idx["CheckIn"]] || std;

    const startLocal = parseLocal(convertDate(date), std);
    const endLocal = parseLocal(convertDate(date), sta);
    if (!startLocal || !endLocal) continue;

    const startISO = startLocal.toISOString();
    const endISO = endLocal.toISOString();

    // 중복 확인
    const duplicate = existingEvents.some(
      (ev) =>
        ev.summary === `${activity} (${from}→${to})` &&
        ev.start?.dateTime?.slice(0, 16) === startISO.slice(0, 16)
    );
    if (duplicate) {
      console.log(`⏩ 이미 존재: ${activity} (${from}→${to})`);
      continue;
    }

    // Google Calendar 이벤트 추가
    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${activity} (${from}→${to})`,
        description: `AcReg: ${acReg}\nBLH: ${blh}\nCheckIn: ${checkIn}`,
        start: { dateTime: startISO, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end: { dateTime: endISO, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      },
    });

    console.log(`✅ 추가: ${activity} (${from}→${to})`);
    await sleep(500); // Rate Limit 보호
  }

  console.log("🎉 Google Calendar 업로드 완료");
}

// ------------------- Date 변환: "Wed 01" → YYYY-MM-DD -------------------
function convertDate(dateLabel) {
  if (!dateLabel) return null;
  const match = dateLabel.match(/\d{1,2}/);
  if (!match) return null;

  const day = Number(match[0]);
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;

  // 날짜가 이미 지난 경우 다음 달로 처리
  if (day < now.getDate() - 15) month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ------------------- 실행 -------------------
main().catch((err) => {
  console.error("❌ 오류 발생:", err.message);
  process.exit(1);
});








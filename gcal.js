// ==================== gcal.js ====================
import fs from "fs";
import path from "path";
import process from "process";
import { google } from "googleapis";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) {
  console.error(" GOOGLE_CALENDAR_ID 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
if (!GOOGLE_CALENDAR_CREDENTIALS) {
  console.error(" GOOGLE_CALENDAR_CREDENTIALS 필요 (GitHub Secrets에 등록)");
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
  const tzOffset = date.getTimezoneOffset() * 60000;
  const localISO = new Date(date - tzOffset).toISOString().slice(0, 19);
  return localISO;
}

function parseLocal(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [yyyy, mm, dd] = dateStr.split("-");
  const [hh, min] = timeStr.split(":");
  return new Date(yyyy, mm - 1, dd, hh, min);
}

// ------------------- 메인 함수 -------------------
async function main() {
  console.log("🚀 Google Calendar 업로드 시작");

  const rosterPath = path.join("public", "roster.json");
  if (!fs.existsSync(rosterPath)) {
    console.error("❌ roster.json 파일이 존재하지 않습니다.");
    process.exit(1);
  }

  const roster = JSON.parse(fs.readFileSync(rosterPath, "utf-8"));

  // 📆 기존 일정 조회 (향후 30일)
  const now = new Date();
  const future = new Date(now);
  future.setDate(future.getDate() + 30);

  const { data: existing } = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const existingEvents = existing.items || [];
  console.log(`📋 기존 일정 ${existingEvents.length}건 확인`);

  for (const item of roster) {
    const { Activity, From, To, STDL, STAL, BLH, AcReg, CheckIn } = item;

    if (!Activity || !From || !To) continue;

    const startLocal = parseLocal(item.Date, STDL);
    const endLocal = parseLocal(item.Date, STAL);
    if (!startLocal || !endLocal) continue;

    const startISO = toISOLocalString(startLocal);
    const endISO = toISOLocalString(endLocal);

    // 🧩 중복 일정 검사
    const duplicate = existingEvents.some(
      (ev) =>
        ev.summary === Activity &&
        ev.start?.dateTime?.startsWith(startISO.slice(0, 16))
    );
    if (duplicate) {
      console.log(`⏩ 이미 존재: ${Activity} (${From}→${To})`);
      continue;
    }

    // ✈️ 새 일정 추가
    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${Activity} (${From}→${To})`,
        description: `AcReg: ${AcReg || "-"}\nBLH: ${BLH || "-"}\nCheckIn: ${
          CheckIn || "-"
        }`,
        start: {
          dateTime: startLocal.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        end: {
          dateTime: endLocal.toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      },
    });

    console.log(`✅ 추가: ${Activity} (${From}→${To})`);
    await sleep(500); // ⚡ 요청 간 0.5초 대기 (Rate Limit 보호)
  }

  console.log("🎉 Google Calendar 업로드 완료");
}

main().catch((err) => {
  console.error("❌ 오류 발생:", err.message);
  process.exit(1);
});







// ==================== gcal.js ====================
import fs from "fs";
import path from "path";
import process from "process";
import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID;
const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
const GOOGLE_CALENDAR_TOKEN = process.env.GOOGLE_CALENDAR_TOKEN;

if (!CALENDAR_ID || !GOOGLE_CALENDAR_CREDENTIALS || !GOOGLE_CALENDAR_TOKEN) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 또는 TOKEN 누락");
  process.exit(1);
}

// ------------------- Date 변환 -------------------
export function convertDate(input) {
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

  return `${year}.${month}.${dayStr}`;
}

// ------------------- Google Calendar 인증 -------------------
const credentials = JSON.parse(GOOGLE_CALENDAR_CREDENTIALS);
const token = JSON.parse(GOOGLE_CALENDAR_TOKEN);

const { client_email, private_key } = credentials;
const auth = new google.auth.JWT({
  email: client_email,
  key: private_key,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

// ------------------- 기존 이벤트 삭제 -------------------
async function deleteExistingGcalEvents() {
  console.log("🗑 기존 gcal.js 이벤트 삭제 시작...");

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    maxResults: 1000,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = res.data.items.filter(
    (e) => e.description && e.description.includes("CREATED_BY_GCALJS")
  );

  for (const event of events) {
    try {
      await calendar.events.delete({
        calendarId: CALENDAR_ID,
        eventId: event.id,
      });
    } catch (err) {
      if (err.code === 410) {
        console.warn(`⚠️ 이미 삭제된 이벤트: ${event.summary}`);
      } else {
        console.error("❌ 삭제 중 오류:", err.message);
      }
    }
  }

  console.log("✅ 기존 이벤트 삭제 완료");
}

// ------------------- 이벤트 업로드 -------------------
async function uploadToGoogleCalendar() {
  console.log("🚀 Google Calendar 업로드 시작");

  const rosterPath = path.join(process.cwd(), "output", "roster.json");
  if (!fs.existsSync(rosterPath)) {
    console.error("❌ roster.json 파일 없음");
    process.exit(1);
  }

  const crewData = JSON.parse(fs.readFileSync(rosterPath, "utf-8"));

  const seen = new Set();

  for (const ev of crewData) {
    const key = `${ev["DATE"]}_${ev["FLT NO"]}_${ev["FROM"]}_${ev["TO"]}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const summary = ev["FLT NO"] || ev["DUTY"] || "Duty";
    const from = ev["FROM"] || "";
    const to = ev["TO"] || "";
    const crew = ev["CREW"] || "";

    let startDateTime = null;
    let endDateTime = null;
    let allDay = false;

    // ✈️ 비행 일정
    if (ev["STD(L)"] && ev["STA(L)"]) {
      startDateTime = new Date(ev["STD(L)"]);
      endDateTime = new Date(ev["STA(L)"]);
    }
    // 🧳 Check-in 일정
    else if (ev["C/I(L)"]) {
      startDateTime = new Date(ev["C/I(L)"]);
      endDateTime = new Date(ev["STD(L)"] || ev["C/I(L)"]);
    }
    // 😴 REST / OFF / STBY 등
    else {
      allDay = true;
      const baseDate = ev["DATE"] || ev["BLH DATE"];
      if (baseDate) {
        const [year, month, day] = baseDate.split(".");
        startDateTime = new Date(`${year}-${month}-${day}T00:00:00`);
        endDateTime = new Date(`${year}-${month}-${day}T23:59:59`);
      }
    }

    const event = {
      summary: summary === "REST" ? "Rest" : `${summary} ${from}→${to}`,
      description: `CREATED_BY_GCALJS\nCrew: ${crew}`,
    };

    if (allDay && startDateTime && endDateTime) {
      event.start = { date: startDateTime.toISOString().split("T")[0] };
      event.end = { date: endDateTime.toISOString().split("T")[0] };
    } else if (startDateTime && endDateTime) {
      event.start = { dateTime: startDateTime.toISOString() };
      event.end = { dateTime: endDateTime.toISOString() };
    } else {
      console.warn(`⚠️ ${summary} 일정에 시간 정보 없음 → 건너뜀`);
      continue;
    }

    try {
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        resource: event,
      });
      console.log(`✅ 이벤트 추가 완료: ${event.summary}`);
    } catch (err) {
      console.error(`❌ ${event.summary} 추가 중 오류:`, err.message);
    }
  }

  console.log("🎉 Google Calendar 업로드 완료");
}

// ------------------- 실행 -------------------
(async () => {
  try {
    await deleteExistingGcalEvents();
    await uploadToGoogleCalendar();
  } catch (err) {
    console.error("❌ 전체 프로세스 오류:", err);
    process.exit(1);
  }
})();





// ==================== gcal.js ====================
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import process from "process";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) {
  console.error("❌ CALENDAR_ID 필요");
  process.exit(1);
}

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
const GOOGLE_CALENDAR_TOKEN = process.env.GOOGLE_CALENDAR_TOKEN;

if (!GOOGLE_CALENDAR_CREDENTIALS || !GOOGLE_CALENDAR_TOKEN) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 또는 TOKEN 누락");
  process.exit(1);
}

const credentials = JSON.parse(GOOGLE_CALENDAR_CREDENTIALS);
const token = JSON.parse(GOOGLE_CALENDAR_TOKEN);

// ------------------- Google API 인증 -------------------
const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
oAuth2Client.setCredentials(token);
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

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

  // ✅ Google Calendar requires ISO format (YYYY-MM-DD)
  return `${year}-${month}-${dayStr}`;
}

// ------------------- HHMM±Offset → Date 변환 -------------------
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;

  const baseDateParts = baseDateStr.split("-");
  let date = new Date(
    Number(baseDateParts[0]),
    Number(baseDateParts[1]) - 1,
    Number(baseDateParts[2]),
    Number(hh),
    Number(mm)
  );
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

// ------------------- 메인 함수 -------------------
async function uploadRosterToCalendar() {
  console.log("🚀 Google Calendar 업로드 시작");

  const rosterPath = path.join(process.cwd(), "output", "roster.json");
  if (!fs.existsSync(rosterPath)) {
    console.error("❌ roster.json 파일을 찾을 수 없습니다.");
    process.exit(1);
  }

  const rosterData = JSON.parse(fs.readFileSync(rosterPath, "utf8"));
  const roster = rosterData?.CrewArray || rosterData;

  if (!Array.isArray(roster)) {
    console.error("❌ 오류 발생: roster is not iterable");
    process.exit(1);
  }

  // ✅ 기존 일정 가져오기
  const now = new Date();
  const timeMin = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth() + 2, 0).toISOString();

  const existingEvents = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime"
  });

  console.log(`📋 기존 일정 ${existingEvents.data.items.length}건 확인`);

  // ------------------- 일정 업로드 -------------------
  for (const duty of roster) {
    const dateStr = convertDate(duty.Date);
    const title = duty.Remark || duty.Dest || "UNKNOWN";

    let event;

    if (["OFF", "REST", "ETC"].includes(title.toUpperCase())) {
      // ✅ All-day event
      event = {
        summary: title,
        start: { date: dateStr },
        end: { date: dateStr }
      };
    } else {
      // ✅ 시간 기반 event
      const startDate = parseHHMMOffset(duty.STD, dateStr);
      const endDate = parseHHMMOffset(duty.STA, dateStr);

      event = {
        summary: `${duty.Flt || ""} ${duty.Dep || ""}-${duty.Dest || ""}`.trim(),
        description: title,
        start: { dateTime: startDate?.toISOString() },
        end: { dateTime: endDate?.toISOString() }
      };
    }

    try {
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: event
      });
      console.log(`✅ 업로드 완료: ${event.summary}`);
    } catch (err) {
      console.error(`❌ 업로드 실패: ${event.summary}`, err.message);
    }
  }

  console.log("🎉 모든 일정 업로드 완료");
}

// ------------------- 실행 -------------------
uploadRosterToCalendar().catch(console.error);


// ==================== gcal.js v10.7 ====================
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import process from "process";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) { console.error("❌ GOOGLE_CALENDAR_ID 필요"); process.exit(1); }

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
if (!GOOGLE_CALENDAR_CREDENTIALS) { console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 필요"); process.exit(1); }

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

function localToUTCms({ year, month, day, hour, minute }, airport) {
  const offset = AIRPORT_OFFSETS[airport] ?? AIRPORT_OFFSETS["ICN"];
  return Date.UTC(year, month - 1, day, hour - offset, minute || 0, 0, 0);
}

function getSystemOffsetMs() { return -new Date().getTimezoneOffset() * 60 * 1000; }

function toISOLocalString(d) {
  const pad = n => (n < 10 ? "0" + n : n);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
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
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

// ------------------- Google Calendar 초기화 -------------------
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/calendar"] });
const calendar = google.calendar({ version: "v3", auth });

// ------------------- 하루 기준 중복 제거 -------------------
async function removeEventsForActivityOnDay(calendarId, activity, dayStr){
  const startDay = new Date(dayStr + "T00:00:00");
  const endDay = new Date(dayStr + "T23:59:59");
  const existing = (await calendar.events.list({
    calendarId,
    timeMin: startDay.toISOString(),
    timeMax: endDay.toISOString(),
    singleEvents: true,
    orderBy: "startTime"
  })).data.items || [];

  for(const ex of existing){
    if(ex.summary === activity){
      await calendar.events.delete({calendarId, eventId: ex.id});
      console.log(`🗑 삭제: ${ex.summary} (${dayStr})`);
    }
  }
}

// ------------------- 메인 -------------------
(async () => {
  console.log("🚀 Google Calendar 업로드 시작");

  const rosterPath = path.join(process.cwd(),"public","roster.json");
  if (!fs.existsSync(rosterPath)) { console.error("❌ roster.json 없음"); process.exit(1); }

  const rosterRaw = JSON.parse(fs.readFileSync(rosterPath,"utf-8"));
  const values = rosterRaw.values;
  if (!Array.isArray(values) || values.length < 2) { console.error("❌ 데이터 없음"); process.exit(1); }

  const headers = values[0];
  const idx = {};
  headers.forEach((h,i)=>idx[h]=i);

  for(let r=1;r<values.length;r++){
    const row = values[r];
    const activity = row[idx["Activity"]];
    if(!activity || !activity.trim()) continue;

    const isoDateStr = parseRosterDate(row[idx["Date"]]);
    if(!isoDateStr) continue;
    const [year, month, day] = isoDateStr.split("-").map(n=>parseInt(n,10));

    const from = row[idx["From"]] || "ICN";
    const to = row[idx["To"]] || "";
    const std = parseTimeStr(row[idx["STD(L)"]]) || parseTimeStr(row[idx["STA(L)"]]);
    const blh = row[idx["BLH"]] || "";

    // 하루 단위로 중복 제거
    await removeEventsForActivityOnDay(CALENDAR_ID, activity, isoDateStr);

    if(/REST/i.test(activity) || !std){
      // All-day event
      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: { summary: activity, start:{date:isoDateStr}, end:{date:isoDateStr}, description:`Crew:${row[idx["Crew"]]}` }
      });
      console.log(`✅ ALL-DAY 추가: ${activity} (${isoDateStr})`);
      continue;
    }

    // Timed event
    const startUtcMs = localToUTCms({year,month,day,hour:std.hour,minute:std.minute}, from);
    const endUtcMs = startUtcMs + (parseBLHtoMinutes(blh) || 120)*60*1000;
    const sysOffset = getSystemOffsetMs();
    const startLocal = new Date(startUtcMs+sysOffset);
    const endLocal = new Date(endUtcMs+sysOffset);

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody:{
        summary:activity,
        location: from+" → "+to,
        description:`AcReg:${row[idx["AcReg"]]} BLH:${blh} From:${from} To:${to}`,
        start:{dateTime:toISOLocalString(startLocal),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},
        end:{dateTime:toISOLocalString(endLocal),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}
      }
    });
    console.log(`✅ 추가: ${activity} (${from}→${to}) [${toISOLocalString(startLocal)}]`);
  }

  console.log("✅ Google Calendar 업로드 완료");
})();








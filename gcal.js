// ==================== gcal.js 10.18 (DST 자동적용 버전) ====================
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
    : JSON.parse(fs.readFileSync(GOOGLE_CALENDAR_CREDENTIALS,"utf-8"));
} catch(e) { console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 파싱 실패:", e.message); process.exit(1); }

// ------------------- 공항 TimeZone (DST 자동 적용용) -------------------
const AIRPORT_TIMEZONES = {
  ICN: "Asia/Seoul",
  LAX: "America/Los_Angeles",
  SFO: "America/Los_Angeles",
  EWR: "America/New_York",
  NRT: "Asia/Tokyo",
  HKG: "Asia/Hong_Kong",
  DAC: "Asia/Dhaka",
  HNL: "Pacific/Honolulu", // ✅ 추가됨 (UTC−10, DST 없음)
  ESB: "Europe/Istanbul",  // ✅ 추가됨 (UTC+3, DST 없음)
  BKK: "Asia/Bangkok", // ✅ 추가됨 (UTC+7, DST 없음)
};

// ------------------- 유틸 함수 -------------------
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
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
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
  if(!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if(!match) return null;
  const [, hh, mm, offset] = match;
  const tz = AIRPORT_TIMEZONES[airport] || AIRPORT_TIMEZONES["ICN"];

  // baseDateStr 형식: YYYY-MM-DD
  const [year, month, day] = baseDateStr.split("-").map(Number);
  const dayOffset = offset ? Number(offset) : 0;
  const localWallTimeAsUtc = Date.UTC(year, month - 1, day + dayOffset, Number(hh), Number(mm));

  // 로컬 시스템 타임존 파싱을 피하고, 공항 타임존의 offset만 이용해 UTC instant로 변환한다.
  const firstGuess = new Date(localWallTimeAsUtc);
  let offsetMs = getTimeZoneOffsetMs(firstGuess, tz);
  let utcTime = new Date(localWallTimeAsUtc - offsetMs);

  // DST 전환 경계에서는 변환 후 offset이 달라질 수 있어 한 번 더 보정한다.
  offsetMs = getTimeZoneOffsetMs(utcTime, tz);
  utcTime = new Date(localWallTimeAsUtc - offsetMs);
  return utcTime;
}

function convertDate(input) {
  if(!input || typeof input !== "string") return input;
  const m = input.match(/\d{1,2}/);
  if(!m) return null;
  const day = String(m[0]).padStart(2,"0");
  const now = new Date();
  let month = now.getUTCMonth()+1;
  if(parseInt(day) < now.getUTCDate()-15) month +=1;
  let year = now.getUTCFullYear();
  if(month>12){ month=1; year+=1; }
  return `${year}-${String(month).padStart(2,"0")}-${day}`;
}

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const WEEKDAY_RE = /\b(mon|tue|wed|thu|fri|sat|sun)\b/i;
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function formatYMD(year, month, day) {
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

function nextMonth(year, month) {
  if(month === 12) return { year: year + 1, month: 1 };
  return { year, month: month + 1 };
}

function addMonths(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function findMonthMatchingWeekday(year, month, day, weekdayToken) {
  if(!weekdayToken) return null;
  const expected = WEEKDAY_INDEX[weekdayToken];
  if(expected === undefined) return null;

  for(const delta of [0, 1, 2, -1]) {
    const candidate = addMonths(year, month, delta);
    const actual = new Date(Date.UTC(candidate.year, candidate.month - 1, day)).getUTCDay();
    if(actual === expected) return candidate;
  }
  return null;
}

function parseRosterDateText(input) {
  if(!input || typeof input !== "string") return null;
  const dayMatch = input.match(/\d{1,2}/);
  if(!dayMatch) return null;

  let explicitMonth = null;
  let weekday = null;
  const monthMatch = input.match(/\b([A-Za-z]{3,9})\b/g);
  if(monthMatch) {
    for(const token of monthMatch) {
      const key = token.toLowerCase();
      if(MONTH_NAMES[key]) {
        explicitMonth = MONTH_NAMES[key];
        break;
      }
      if(WEEKDAY_INDEX[key] !== undefined) weekday = key;
    }
  }

  return {
    day: Number(dayMatch[0]),
    explicitMonth,
    weekday,
    hasWeekday: WEEKDAY_RE.test(input),
  };
}

function resolveRosterDateSequence(rows, dateIndex) {
  const resolved = new WeakMap();
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  let lastDay = null;
  let currentDate = null;

  for(const row of rows) {
    const parsed = parseRosterDateText(row[dateIndex]);

    if(parsed) {
      if(parsed.explicitMonth) {
        if(parsed.explicitMonth < month && month - parsed.explicitMonth > 6) year += 1;
        month = parsed.explicitMonth;
      } else if(lastDay !== null && parsed.hasWeekday && parsed.day < lastDay) {
        const next = nextMonth(year, month);
        year = next.year;
        month = next.month;
      } else if(parsed.weekday) {
        const matched = findMonthMatchingWeekday(year, month, parsed.day, parsed.weekday);
        if(matched) {
          year = matched.year;
          month = matched.month;
        }
      }

      currentDate = formatYMD(year, month, parsed.day);
      lastDay = parsed.day;
    }

    if(currentDate) resolved.set(row, currentDate);
  }

  return resolved;
}

// ------------------- Google Calendar 초기화 -------------------
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes:["https://www.googleapis.com/auth/calendar"] });
const calendar = google.calendar({ version:"v3", auth });

// ------------------- 기존 gcal.js 이벤트 삭제 -------------------
async function deleteExistingGcalEvents(){
  console.log("🗑 기존 gcal.js 이벤트 삭제 시작...");
  let pageToken;
  do {
    const res = await calendar.events.list({ calendarId: CALENDAR_ID, singleEvents:true, orderBy:"startTime", pageToken });
    const events = res.data.items || [];
    for(const ev of events){
      if((ev.description||"").includes("CREATED_BY_GCALJS")){
        try{ await calendar.events.delete({calendarId:CALENDAR_ID,eventId:ev.id}); console.log(`🗑 삭제: ${ev.summary}`); }
        catch(e){ if(e.code!==410) console.error("❌ 삭제 실패:",e.message); }
      }
    }
    pageToken = res.data.nextPageToken;
  }while(pageToken);
  console.log("✅ 기존 gcal.js 이벤트 삭제 완료");
}

// ------------------- Event Insert Retry & Throttle -------------------
async function insertEventWithRetry(eventBody,retries=5){
  for(let i=0;i<retries;i++){
    try{ await calendar.events.insert(eventBody); return; }
    catch(e){
      if(e.code===403 && e.errors?.some(err=>err.reason==="rateLimitExceeded")){
        const delayMs = Math.pow(2,i)*1000;
        console.log(`⚠️ Rate limit exceeded, retry in ${delayMs}ms...`);
        await new Promise(res=>setTimeout(res,delayMs));
      } else throw e;
    }
  }
  throw new Error("Max retries exceeded for event insertion");
}
function delay(ms){ return new Promise(res=>setTimeout(res,ms)); }

// ------------------- 사후 중복 제거 -------------------
async function removeDuplicates() {
  console.log("🗑 사후 중복 제거 시작...");
  let pageToken;
  const allEvents = [];
  do {
    const res = await calendar.events.list({ calendarId: CALENDAR_ID, singleEvents:true, orderBy:"startTime", pageToken });
    allEvents.push(...(res.data.items||[]));
    pageToken = res.data.nextPageToken;
  } while(pageToken);

  const seen = new Map();
  for(const ev of allEvents){
    if(!(ev.description||"").includes("CREATED_BY_GCALJS")) continue;
    const startDate = ev.start?.dateTime ? new Date(ev.start.dateTime).toISOString().slice(0,10) : ev.start?.date;
    const [from,to] = ev.location?.split(" → ") || ["",""];
    const key = `${startDate}|${ev.summary}|${from}|${to}`;
    if(seen.has(key)){
      try{ await calendar.events.delete({calendarId:CALENDAR_ID,eventId:ev.id}); console.log(`🗑 중복 제거: ${ev.summary} (${startDate})`); }
      catch(e){ if(e.code!==410) console.error("❌ 중복 삭제 실패:",e.message); }
    } else seen.set(key,ev.id);
  }
  console.log("✅ 사후 중복 제거 완료");
}

// ------------------- Main -------------------
(async()=>{
  console.log("🚀 Google Calendar 업로드 시작 (DST 자동적용 버전 10.18)");
  await deleteExistingGcalEvents();

  const rosterPath = path.join(process.cwd(),"public","roster.json");
  if(!fs.existsSync(rosterPath)){ console.error("❌ roster.json 없음"); process.exit(1); }
  const rosterRaw = JSON.parse(fs.readFileSync(rosterPath,"utf-8"));
  const values = rosterRaw.values;
  if(!Array.isArray(values) || values.length<2){ console.error("❌ 데이터 없음"); process.exit(1); }

  const headers = values[0];
  const idx = {};
  headers.forEach((h,i)=>idx[h]=i);
  const resolvedDates = resolveRosterDateSequence(values.slice(1), idx["Date"]);

  for(let r=1;r<values.length;r++){
    const row = values[r];
    const activity = row[idx["Activity"]];
    if(!activity||!activity.trim()) continue;

    const rawDate = row[idx["Date"]];
    const convDate = resolvedDates.get(row) || convertDate(rawDate);
    if(!convDate) continue;
   
    const from = row[idx["From"]] || "ICN";
    const to = row[idx["To"]] || "";
    const stdLStr = row[idx["STD(L)"]] || "0000";
    const staLStr = row[idx["STA(L)"]] || "0000";
    const stdZStr = row[idx["STD(Z)"]] || "";
    const staZStr = row[idx["STA(Z)"]] || "";
    const ciLStr  = row[idx["C/I(L)"]] || "0000";
    const blhStr  = row[idx["BLH"]]   || "00:00";

    // ALL-DAY 이벤트
    if(/REST|OFF|ETC/i.test(activity) || stdLStr==="0000" || staLStr==="0000"){
      await insertEventWithRetry({
        calendarId: CALENDAR_ID,
        requestBody:{
          summary: activity,
          start:{date: convDate},
          end:{date: convDate},
          description:`CREATED_BY_GCALJS\nCrew: ${row[idx["Crew"]]||""}`
        }
      });
      console.log(`✅ ALL-DAY 추가: ${activity} (${convDate})`);
      await delay(200);
      continue;
    }

    // Flight 이벤트
    const startLocal = parseHHMMOffset(stdLStr, convDate, from);
    const endLocal   = parseHHMMOffset(staLStr, convDate, to);
    if(!startLocal || !endLocal) continue;
    if(endLocal<=startLocal) endLocal.setDate(endLocal.getDate()+1);

    const description = `
Activity: ${activity}
From: ${from} To: ${to}
C/I(L): ${ciLStr}
STD(L): ${stdLStr} STA(L): ${staLStr}
STD(Z): ${stdZStr} STA(Z): ${staZStr}
AcReg: ${row[idx["AcReg"]] || ""}
Blockhours: ${blhStr}
Crew: ${row[idx["Crew"]] || ""}
CREATED_BY_GCALJS
`.trim();

    await insertEventWithRetry({
      calendarId: CALENDAR_ID,
      requestBody:{
        summary: activity,
        location: `${from} → ${to}`,
        description,
        start:{dateTime:startLocal.toISOString(), timeZone: "UTC"},
        end:{dateTime:endLocal.toISOString(), timeZone: "UTC"},
      }
    });
    console.log(`✅ 비행 추가 (DST): ${activity} (${from}→${to}) [${startLocal.toISOString()}]`);
    await delay(200);
  }

  await removeDuplicates();
  console.log("✅ Google Calendar 업로드 완료 (DST 자동적용)");
})();

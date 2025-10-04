// ==================== gcal.js 10.14 ====================
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

// ------------------- 공항 UTC 오프셋 -------------------
const AIRPORT_OFFSETS = { ICN: 9, LAX: -7, SFO: -7, EWR: -4, NRT: 9, HKG: 8, DAC: 6 };

// ------------------- 유틸 함수 -------------------
function parseHHMMOffset(str, baseDateStr, airport) {
  if(!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if(!match) return null;
  const [, hh, mm, offset] = match;
  const [year, month, day] = baseDateStr.split("-").map(Number);
  let dateObj = new Date(Date.UTC(year, month-1, day, Number(hh), Number(mm)));
  const airportOffset = AIRPORT_OFFSETS[airport] ?? AIRPORT_OFFSETS["ICN"];
  dateObj.setUTCHours(dateObj.getUTCHours() - airportOffset);
  if(offset) dateObj.setUTCDate(dateObj.getUTCDate() + Number(offset));
  return dateObj;
}

function convertDate(input) {
  if(!input || typeof input !== "string") return input;
  const m = input.match(/\d{1,2}/);
  if(!m) return null;
  const day = String(m[0]).padStart(2,"0");
  const now = new Date();
  let month = now.getMonth()+1;
  if(parseInt(day) < now.getDate()-15) month +=1;
  let year = now.getFullYear();
  if(month>12){ month=1; year+=1; }
  return `${year}-${String(month).padStart(2,"0")}-${day}`;
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

// ------------------- 중복 체크 -------------------
const insertedDailyActivities = new Set();
function isDailyDuplicate(activity,dateStr){ 
  const key = `${dateStr}|${activity}`;
  if(insertedDailyActivities.has(key)) return true;
  insertedDailyActivities.add(key);
  return false;
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

// ------------------- Main -------------------
(async()=>{
  console.log("🚀 Google Calendar 업로드 시작");
  await deleteExistingGcalEvents();

  const rosterPath = path.join(process.cwd(),"public","roster.json");
  if(!fs.existsSync(rosterPath)){ console.error("❌ roster.json 없음"); process.exit(1); }
  const rosterRaw = JSON.parse(fs.readFileSync(rosterPath,"utf-8"));
  const values = rosterRaw.values;
  if(!Array.isArray(values) || values.length<2){ console.error("❌ 데이터 없음"); process.exit(1); }

  const headers = values[0];
  const idx = {};
  headers.forEach((h,i)=>idx[h]=i);

  for(let r=1;r<values.length;r++){
    const row = values[r];
    const activity = row[idx["Activity"]];
    if(!activity||!activity.trim()) continue;

    const rawDate = row[idx["Date"]];
    const convDate = convertDate(rawDate);
    if(!convDate) continue;
    const eventDateStr = convDate;

    if(isDailyDuplicate(activity,eventDateStr)){
      console.log(`⚠️ 중복 Activity 스킵: ${activity} (${eventDateStr})`);
      continue;
    }

    const from = row[idx["From"]] || "ICN";
    const to = row[idx["To"]] || "";
    const stdLStr = row[idx["STD(L)"]] || "0000";
    const staLStr = row[idx["STA(L)"]] || "0000";
    const ciLStr  = row[idx["CI(L)"]] || "0000";
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
CREATED_BY_GCALJS
Activity: ${activity}
Crew: ${row[idx["Crew"]]||""}
From: ${from} To: ${to}
STD(L): ${stdLStr} STA(L): ${staLStr}
CI(L): ${ciLStr}
AcReg: ${row[idx["AcReg"]]||""} Blockhours: ${blhStr}
    `.trim();

    await insertEventWithRetry({
      calendarId: CALENDAR_ID,
      requestBody:{
        summary: activity,
        location: `${from} → ${to}`,
        description,
        start:{dateTime:startLocal.toISOString(), timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},
        end:{dateTime:endLocal.toISOString(), timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},
      }
    });
    console.log(`✅ 비행 추가: ${activity} (${from}→${to}) [${startLocal.toISOString()}]`);
    await delay(200);
  }

  console.log("✅ Google Calendar 업로드 완료");
})();
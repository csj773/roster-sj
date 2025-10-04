// ==================== gcal.js ====================
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import process from "process";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID;
if(!CALENDAR_ID){ console.error("❌ CALENDAR_ID 필요"); process.exit(1); }

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
if(!GOOGLE_CALENDAR_CREDENTIALS){ console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 필요"); process.exit(1); }

let creds;
try {
  creds = GOOGLE_CALENDAR_CREDENTIALS.trim().startsWith("{") ? JSON.parse(GOOGLE_CALENDAR_CREDENTIALS) : JSON.parse(fs.readFileSync(GOOGLE_CALENDAR_CREDENTIALS, "utf-8"));
} catch(e){
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 파싱 실패:", e.message);
  process.exit(1);
}

// ------------------- 공항 UTC 오프셋 -------------------
const AIRPORT_OFFSETS = { ICN:9, LAX:-7, SFO:-7, EWR:-4, NRT:9, HKG:8, DAC:6 };

// ------------------- 유틸 함수 -------------------
function parseTimeStr(t){
  if(!t) return null;
  const m=t.trim().match(/^(\d{1,2}):?(\d{2})?$/);
  if(!m) return null;
  return { hour:parseInt(m[1],10), minute:m[2]?parseInt(m[2],10):0 };
}

function parseBLHtoMinutes(blh){
  if(!blh) return null;
  const m=blh.trim().match(/^(\d{1,2}):(\d{2})$/);
  if(!m) return null;
  return parseInt(m[1],10)*60+parseInt(m[2],10);
}

function localToUTCms({year,month,day,hour,minute}, airport){
  const offset=AIRPORT_OFFSETS[airport];
  if(offset===undefined) throw new Error(`Unknown airport offset: ${airport}`);
  return Date.UTC(year,month-1,day,hour-offset,minute||0,0,0);
}

function getSystemOffsetMs(){ return -new Date().getTimezoneOffset()*60*1000; }
function toISOLocalString(d){ const pad=n=>n<10?"0"+n:n; return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`; }

// ------------------- Google Calendar 초기화 -------------------
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes:["https://www.googleapis.com/auth/calendar"] });
const calendar = google.calendar({version:"v3", auth});

// ------------------- 메인 -------------------
(async()=>{
  console.log("🚀 Google Calendar 업로드 시작");

  const rosterPath = path.join(process.cwd(),"public","roster.json");
  if(!fs.existsSync(rosterPath)){ console.error("❌ roster.json 없음"); process.exit(1); }

  const rosterRaw = JSON.parse(fs.readFileSync(rosterPath,"utf-8"));
  const values = rosterRaw.values;
  if(!Array.isArray(values)||values.length<2){ console.error("❌ 데이터 없음"); process.exit(1); }

  const headers = values[0];
  const idx={}; headers.forEach((h,i)=>idx[h]=i);

  for(let r=1;r<values.length;r++){
    const row = values[r];
    const activity = row[idx["Activity"]];
    if(!activity || !activity.trim()) continue;

    const dateParts = row[idx["Date"]].split("-").map(n=>parseInt(n,10));
    const year=dateParts[0], month=dateParts[1], day=dateParts[2];

    const from=row[idx["From"]]||"ICN", to=row[idx["To"]]||"";
    const std=parseTimeStr(row[idx["STD(L)"]])||parseTimeStr(row[idx["STA(L)"]]);
    const blh=row[idx["BLH"]]||"";

    // All-day event (REST)
    if(/REST/i.test(activity) || !std){
      const dayStr=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      await calendar.events.insert({
        calendarId:CALENDAR_ID,
        requestBody:{
          summary:activity,
          start:{date:dayStr},
          end:{date:dayStr},
          description:`Crew:${row[idx["Crew"]]}`
        }
      });
      console.log(`✅ ALL-DAY 추가: ${activity} (${dayStr})`);
      continue;
    }

    // Normal timed event
    const startUtcMs = localToUTCms({year,month,day,hour:std.hour,minute:std.minute},from);
    const durationMin = parseBLHtoMinutes(blh)||120;
    const endUtcMs = startUtcMs+durationMin*60*1000;

    const sysOffset=getSystemOffsetMs();
    const startLocal=new Date(startUtcMs+sysOffset);
    const endLocal=new Date(endUtcMs+sysOffset);

    // 중복 제거: summary+start.dateTime 같은 이벤트 삭제
    const startDay = new Date(startLocal); startDay.setHours(0,0,0,0);
    const endDay = new Date(startLocal); endDay.setHours(23,59,59,999);
    const existing = (await calendar.events.list({
      calendarId:CALENDAR_ID,
      timeMin:startDay.toISOString(),
      timeMax:endDay.toISOString(),
      singleEvents:true,
      orderBy:"startTime"
    })).data.items||[];

    for(const ex of existing){
      const exStartMs = ex.start.dateTime?new Date(ex.start.dateTime).getTime():new Date(ex.start.date+"T00:00:00").getTime();
      if(ex.summary===activity && exStartMs===startLocal.getTime()){
        await calendar.events.delete({calendarId:CALENDAR_ID,eventId:ex.id});
        console.log(`🗑 삭제: ${ex.summary}`);
      }
    }

    await calendar.events.insert({
      calendarId:CALENDAR_ID,
      requestBody:{
        summary:activity,
        location: from+" → "+to,
        description:`AcReg:${row[idx["AcReg"]]} BLH:${blh} From:${from} To:${to}`,
        start:{dateTime:toISOLocalString(startLocal), timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},
        end:{dateTime:toISOLocalString(endLocal), timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}
      }
    });
    console.log(`✅ 추가: ${activity} (${from}→${to}) [${toISOLocalString(startLocal)}]`);
  }

  console.log("✅ Google Calendar 업로드 완료");
})();


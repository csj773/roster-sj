// gcal.js

import fs from "fs";
import { google } from "googleapis";
import process from "process";

// ----------------- 설정 -----------------
const ROSTER_JSON_PATH = process.env.ROSTER_JSON_PATH || "./public/roster.json";
const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID;
const BASE_YEAR = parseInt(process.env.BASE_YEAR || `${new Date().getFullYear()}`, 10);

if (!CALENDAR_ID) {
  console.error("❌ CALENDAR_ID(혹은 GOOGLE_CALENDAR_ID) 환경변수가 필요합니다.");
  process.exit(1);
}

// GOOGLE_CALENDAR_CREDENTIALS can be either:
// - a JSON string with service account credentials, or
// - a path to a credentials JSON file.
let googleCredentialsRaw = process.env.GOOGLE_CALENDAR_CREDENTIALS || process.env.GOOGLE_SHEETS_CREDENTIALS;
if (!googleCredentialsRaw) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS (or GOOGLE_SHEETS_CREDENTIALS) 환경변수가 필요합니다.");
  process.exit(1);
}
let googleCredentials;
try {
  // if it's a path to file
  if (googleCredentialsRaw.trim().startsWith("{")) googleCredentials = JSON.parse(googleCredentialsRaw);
  else googleCredentials = JSON.parse(fs.readFileSync(googleCredentialsRaw, "utf-8"));
} catch (e) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 파싱 실패:", e.message);
  process.exit(1);
}

// ----------------- 헬퍼 상수 -----------------
// roster.js의 headers 순서와 일치해야 함
const EXPECTED_HEADERS = ["Date","DC","C/I(L)","C/O(L)","Activity","F","From","STD(L)","STD(Z)","To","STA(L)","STA(Z)","BLH","AcReg","Crew"];

// 공항별 UTC 오프셋 (단위: 시간). 필요시 추가/수정하세요.
// 주의: DST 처리는 수동으로 지정 (예: LAX/SFO는 PDT => -7, EWR은 EDT => -4 등)
const AIRPORT_OFFSETS = {
  "ICN": 9,
  "LAX": -7,
  "SFO": -7,
  "EWR": -4,
  // 추가 공항: "NRT": 9, "HKG": 8 ...
};

// 날짜 문자열 -> {year,month,day}
// 허용 포맷(간단): "MM/DD", "M/D", "YYYY-MM-DD", "YYYY/M/D", "DD" (해당 월 추론 불가 시 실패)
function parseDateRaw(dateRaw) {
  if (!dateRaw) return null;
  dateRaw = dateRaw.toString().trim();
  // 형식 YYYY-MM-DD
  const isoMatch = dateRaw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) return { year: parseInt(isoMatch[1],10), month: parseInt(isoMatch[2],10), day: parseInt(isoMatch[3],10) };
  // 형식 M/D 또는 MM/DD
  const mdMatch = dateRaw.match(/^(\d{1,2})[\/\.-](\d{1,2})$/);
  if (mdMatch) return { year: BASE_YEAR, month: parseInt(mdMatch[1],10), day: parseInt(mdMatch[2],10) };
  // 형식 D (just day) -> assume current month
  const dOnly = dateRaw.match(/^(\d{1,2})$/);
  if (dOnly) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth()+1, day: parseInt(dOnly[1],10) };
  }
  // 기타: 시도해볼 수 있는 포맷 (e.g., "7 OCT" 등)
  const alt = dateRaw.match(/^(\d{1,2})\s*[A-Za-z]{3,}$/);
  if (alt) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth()+1, day: parseInt(alt[1],10) };
  }
  return null;
}

// 시간 문자열 "HH:MM" 또는 "H:MM" -> {hour,minute}
function parseTimeStr(t) {
  if (!t) return null;
  const m = t.trim().match(/^(\d{1,2}):?(\d{2})?$/);
  if (!m) return null;
  const hour = parseInt(m[1],10);
  const minute = m[2] ? parseInt(m[2],10) : 0;
  return { hour, minute };
}

// BLH "HH:MM" -> 분 단위 duration
function parseBLHtoMinutes(blh) {
  if (!blh) return null;
  const m = blh.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1],10)*60 + parseInt(m[2],10);
}

// 주어진 공항 로컬 날짜/시각 -> UTC timestamp (ms)
// year,month,day numbers, time {hour,minute}, airport code -> returns epoch ms
function localToUTCms({year, month, day, hour, minute}, airport) {
  const offset = AIRPORT_OFFSETS[airport];
  if (offset === undefined) {
    throw new Error(`Unknown airport offset for ${airport}. Add to AIRPORT_OFFSETS.`);
  }
  // UTC = local time - offset
  // Build UTC Date by subtracting offset hours from given local time
  // Date.UTC takes (year, monthIndex, day, hour, minute, second, ms)
  const utcMs = Date.UTC(year, month-1, day, hour - offset, minute || 0, 0, 0);
  return utcMs;
}

// 시스템(기기) 로컬 tz offset in ms (system local time = UTC + localOffsetMs)
function getSystemOffsetMs() {
  return -new Date().getTimezoneOffset() * 60 * 1000; // getTimezoneOffset: minutes to add to local -> UTC, so negate
}

// ISO string without timezone for a Date object in system local time
function toISOLocalString(d) {
  const pad = (n) => (n<10 ? "0"+n : n);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

// ----------------- Google Calendar 초기화 -----------------
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const auth = new google.auth.GoogleAuth({
  credentials: googleCredentials,
  scopes: SCOPES
});
const calendar = google.calendar({version: "v3", auth});

// ----------------- 로직 -----------------
async function main() {
  console.log("🚀 roster-to-gcal 시작");

  // roster.json 로드
  if (!fs.existsSync(ROSTER_JSON_PATH)) {
    console.error("❌ roster.json 파일을 찾을 수 없습니다:", ROSTER_JSON_PATH);
    process.exit(1);
  }
  const rosterRaw = JSON.parse(fs.readFileSync(ROSTER_JSON_PATH, "utf-8"));
  const values = rosterRaw.values;
  if (!Array.isArray(values) || values.length < 2) {
    console.error("❌ roster.json에 데이터가 없습니다.");
    process.exit(1);
  }
  const headers = values[0];
  // map header indexes
  const idx = {};
  EXPECTED_HEADERS.forEach(h => { const i = headers.findIndex(c => c===h); idx[h]=i; });

  // 이벤트 추가/업데이트 대상 배열 생성
  const eventsToUpsert = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const activity = row[idx["Activity"]] || "";
    if (!activity || activity.trim()==="") continue;

    // Date raw (from roster)
    const dateRaw = row[idx["Date"]] || "";
    const parsedDate = parseDateRaw(dateRaw);
    if (!parsedDate) {
      console.warn(`⚠️ 행 ${r}의 Date 파싱 실패 (${dateRaw}). 건너뜁니다.`);
      continue;
    }

    const from = (row[idx["From"]] || "").trim();
    const to = (row[idx["To"]] || "").trim();
    const stdLocalStr = (row[idx["STD(L)"]] || "").trim();
    const staLocalStr = (row[idx["STA(L)"]] || "").trim();
    const blh = (row[idx["BLH"]] || "").trim();
    const acReg = (row[idx["AcReg"]] || "").trim();

    // Prefer STD(L) for start time; if missing and Activity contains "REST" -> use default times
    const startTimeParsed = parseTimeStr(stdLocalStr) || parseTimeStr(staLocalStr);
    if (!startTimeParsed) {
      // For REST or non-flight rows, we can set all-day or set start at 00:00 of Date
      // We'll skip if neither time nor BLH available => but create all-day event for REST
      if (/REST/i.test(activity)) {
        // create all-day spanning that date (local)
        const startDateISO = `${parsedDate.year}-${String(parsedDate.month).padStart(2,'0')}-${String(parsedDate.day).padStart(2,'0')}`;
        eventsToUpsert.push({
          summary: activity,
          location: from || "",
          description: `AcReg:${acReg} BLH:${blh}`,
          allDay: true,
          date: startDateISO
        });
        continue;
      } else {
        console.warn(`⚠️ 행 ${r}의 시간 정보 누락 (STD/STA). Activity: ${activity}. 건너뜁니다.`);
        continue;
      }
    }

    // compute UTC ms of start (using airport offset)
    const startUtcMs = localToUTCms({
      year: parsedDate.year,
      month: parsedDate.month,
      day: parsedDate.day,
      hour: startTimeParsed.hour,
      minute: startTimeParsed.minute
    }, from || "ICN"); // if no from, assume ICN (KST)

    // compute duration minutes from BLH (if available) else default 120
    const durationMin = parseBLHtoMinutes(blh) || 120;
    const endUtcMs = startUtcMs + durationMin*60*1000;

    // convert to system local ms
    const sysOffsetMs = getSystemOffsetMs();
    const startLocalMs = startUtcMs + sysOffsetMs;
    const endLocalMs = endUtcMs + sysOffsetMs;

    const startLocalDate = new Date(startLocalMs);
    const endLocalDate = new Date(endLocalMs);

    eventsToUpsert.push({
      summary: activity,
      location: from ? `${from} → ${to || ""}` : (to || ""),
      description: `AcReg:${acReg} BLH:${blh} From:${from} To:${to}`,
      start: {
        dateTime: toISOLocalString(startLocalDate),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      end: {
        dateTime: toISOLocalString(endLocalDate),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
      },
      rawRowIndex: r
    });
  }

  console.log(`총 생성/업데이트 후보 이벤트 수: ${eventsToUpsert.length}`);

  // 날짜별로 처리 — 중복 제거 로직:
  // "같은 날짜" 범위(00:00 ~ 23:59 시스템 로컬)에서 summary와 start.dateTime이 같은 기존 이벤트를 중복으로 판단하여 삭제 후 새로 삽입.
  // (기존 이벤트 검색: summary 포함/시간 범위로 조회)
  const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  for (const ev of eventsToUpsert) {
    try {
      if (ev.allDay) {
        // all-day event: use date (YYYY-MM-DD)
        const day = ev.date;
        const startOfDay = new Date(`${day}T00:00:00`);
        const endOfDay = new Date(startOfDay.getTime() + 24*3600*1000 - 1);

        // list existing events in that day
        const listRes = await calendar.events.list({
          calendarId: CALENDAR_ID,
          timeMin: startOfDay.toISOString(),
          timeMax: endOfDay.toISOString(),
          singleEvents: true,
          orderBy: "startTime",
        });
        const existing = listRes.data.items || [];

        // delete duplicates: same summary AND allDay (no dateTime start) or start.date == day
        for (const ex of existing) {
          const exSummary = ex.summary || "";
          const exStart = ex.start || {};
          const exAllDay = !!ex.start?.date;
          if (exSummary === ev.summary && (exAllDay || exStart.date === day)) {
            await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ex.id });
            console.log(`삭제: existing all-day event "${exSummary}" (${ex.id})`);
          }
        }

        // insert new all-day event
        const insertRes = await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: {
            summary: ev.summary,
            location: ev.location,
            description: ev.description,
            start: { date: day },
            end: { date: (() => {
              // Google all-day event end.date is non-inclusive -> set next day
              const d = new Date(day + "T00:00:00");
              const next = new Date(d.getTime() + 24*3600*1000);
              return `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`;
            })() }
          }
        });
        console.log(`추가(ALL-DAY): ${ev.summary} (${insertRes.data.id})`);
        continue;
      }

      // Normal timed event
      const startISO = new Date(ev.start.dateTime).toISOString();
      const eventDayStart = new Date(new Date(ev.start.dateTime).setHours(0,0,0,0)).toISOString();
      const eventDayEnd = new Date(new Date(ev.start.dateTime).setHours(23,59,59,999)).toISOString();

      // search existing events in that day
      const listRes = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: eventDayStart,
        timeMax: eventDayEnd,
        singleEvents: true,
        orderBy: "startTime",
      });
      const existing = listRes.data.items || [];

      // Delete duplicates: same summary AND start.datetime equal (string compare local ISO) — keep only one
      for (const ex of existing) {
        const exStartDT = ex.start && (ex.start.dateTime || ex.start.date);
        const exSummary = ex.summary || "";
        // normalize comparable strings: both to ms
        let exStartMs = null;
        if (ex.start && ex.start.dateTime) exStartMs = new Date(ex.start.dateTime).getTime();
        else if (ex.start && ex.start.date) exStartMs = new Date(ex.start.date + "T00:00:00").getTime();
        const evStartMs = new Date(ev.start.dateTime).getTime();

        if (exSummary === ev.summary && exStartMs === evStartMs) {
          // duplicate -> delete
          await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: ex.id });
          console.log(`삭제: 중복 이벤트 "${exSummary}" (${ex.id})`);
        }
      }

      // insert event
      const insertRes = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: ev.summary,
          location: ev.location,
          description: ev.description,
          start: ev.start,
          end: ev.end
        }
      });
      console.log(`추가: ${ev.summary} (${insertRes.data.id}) [${ev.start.dateTime} - ${ev.end.dateTime} ${ev.start.timeZone}]`);
    } catch (err) {
      console.error("❌ 이벤트 처리 중 오류:", err && err.message ? err.message : err);
    }
  }

  console.log("✅ 모든 처리 완료");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

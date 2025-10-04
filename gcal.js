// ==================== gcal.js (fixed 10.17+ dedupe) ====================
import fs from "fs";
import path from "path";
import { google } from "googleapis";
import process from "process";

// ------------------- 환경변수 -------------------
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
if (!CALENDAR_ID) {
  console.error("❌ GOOGLE_CALENDAR_ID 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

const GOOGLE_CALENDAR_CREDENTIALS = process.env.GOOGLE_CALENDAR_CREDENTIALS;
if (!GOOGLE_CALENDAR_CREDENTIALS) {
  console.error("❌ GOOGLE_CALENDAR_CREDENTIALS 필요 (GitHub Secrets에 등록)");
  process.exit(1);
}

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
const AIRPORT_OFFSETS = {
  ICN: 9, LAX: -7, SFO: -7, EWR: -4,
  NRT: 9, HKG: 8, DAC: 6
};

// ------------------- Date 변환 -------------------
function convertDate(input) {
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
  return `${year}-${month}-${dayStr}`;
}

// ------------------- HHMM±Offset → Date 변환 (UTC → Local 포함) -------------------
function parseHHMMOffset(str, baseDateStr, airport) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;

  const baseParts = baseDateStr.split("-");
  let year = Number(baseParts[0]);
  let month = Number(baseParts[1]) - 1;
  let day = Number(baseParts[2]);

  if (offset) day += Number(offset);

  const airportOffset = AIRPORT_OFFSETS[airport] ?? AIRPORT_OFFSETS["ICN"];
  const utcDate = new Date(Date.UTC(year, month, day, Number(hh) - airportOffset, Number(mm)));

  const sysOffset = -new Date().getTimezoneOffset() * 60000;
  return new Date(utcDate.getTime() + sysOffset);
}

// ------------------- Google Calendar 초기화 -------------------
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/calendar"],
});
const calendar = google.calendar({ version: "v3", auth });

// ------------------- 기존 gcal.js 이벤트 삭제 -------------------
async function deleteExistingGcalEvents() {
  console.log("🗑 기존 gcal.js 이벤트 삭제 시작...");
  let pageToken;
  do {
    const eventsRes = await calendar.events.list({
      calendarId: CALENDAR_ID,
      singleEvents: true,
      orderBy: "startTime",
      pageToken,
    });
    const events = eventsRes.data.items || [];
    for (const ev of events) {
      if ((ev.description || "").includes("CREATED_BY_GCALJS")) {
        try {
          await calendar.events.delete({
            calendarId: CALENDAR_ID,
            eventId: ev.id,
          });
          console.log(`🗑 삭제: ${ev.summary}`);
        } catch (e) {
          if (e.code === 410) console.log(`⚠️ 이미 삭제됨: ${ev.summary}`);
          else console.error("❌ 삭제 실패:", e.message);
        }
      }
    }
    pageToken = eventsRes.data.nextPageToken;
  } while (pageToken);
  console.log("✅ 기존 gcal.js 이벤트 삭제 완료");
}

// ------------------- 이벤트 중복 체크 -------------------
async function isDuplicateEvent(summary, startISO, endISO, location) {
  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: new Date(new Date(startISO).getTime() - 1 * 60000).toISOString(),
    timeMax: new Date(new Date(endISO).getTime() + 1 * 60000).toISOString(),
    singleEvents: true,
  });
  const items = res.data.items || [];
  return items.some(
    ev =>
      ev.summary === summary &&
      ev.start?.dateTime === startISO &&
      ev.end?.dateTime === endISO &&
      (ev.location || "") === location
  );
}

// ------------------- gcal.js 메인 -------------------
(async () => {
  console.log("🚀 Google Calendar 업로드 시작");

  await deleteExistingGcalEvents();

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

  const headers = values[0];
  const idx = {};
  headers.forEach((h, i) => (idx[h] = i));

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const activity = row[idx["Activity"]];
    if (!activity || !activity.trim()) continue;

    const rawDate = row[idx["Date"]];
    const convDate = convertDate(rawDate);
    if (!convDate) continue;

    const from = row[idx["From"]] || "ICN";
    const to = row[idx["To"]] || "";

    const stdLStr = row[idx["STD(L)"]] || "0000";
    const staLStr = row[idx["STA(L)"]] || "0000";
    const ciLStr = row[idx["CI(L)"]] || "";

    // ------------------- ALL-DAY 이벤트 처리 -------------------
    if (/REST|OFF|ETC/i.test(activity) || stdLStr === "0000" || staLStr === "0000") {
      const startISO = convDate;
      const endISO = convDate;
      if (!(await isDuplicateEvent(activity, startISO, endISO, ""))) {
        await calendar.events.insert({
          calendarId: CALENDAR_ID,
          requestBody: {
            summary: activity,
            start: { date: startISO },
            end: { date: endISO },
            description: `CREATED_BY_GCALJS\nCrew: ${row[idx["Crew"]] || ""}`,
          },
        });
        console.log(`✅ ALL-DAY 추가: ${activity} (${convDate})`);
      } else {
        console.log(`⚠️ 중복 ALL-DAY 스킵: ${activity} (${convDate})`);
      }
      continue;
    }

    // ------------------- Check-in 이벤트 -------------------
    if (ciLStr) {
      const checkInTime = parseHHMMOffset(ciLStr, convDate, from);
      if (checkInTime) {
        const startISO = checkInTime.toISOString();
        const endISO = new Date(checkInTime.getTime() + 30 * 60000).toISOString(); // 체크인 30분
        if (!(await isDuplicateEvent(`Check-in ${from} ${activity}`, startISO, endISO, from))) {
          await calendar.events.insert({
            calendarId: CALENDAR_ID,
            requestBody: {
              summary: `Check-in ${from} ${activity}`,
              location: from,
              description: `CREATED_BY_GCALJS\nCrew: ${row[idx["Crew"]] || ""}`,
              start: { dateTime: startISO, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
              end: { dateTime: endISO, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            },
          });
          console.log(`🕐 Check-in 추가: ${from} ${activity}`);
        }
      }
    }

    // ------------------- Flight 이벤트 -------------------
    const startLocal = parseHHMMOffset(stdLStr, convDate, from);
    const endLocal = parseHHMMOffset(staLStr, convDate, to);
    if (!startLocal || !endLocal) continue;
    if (endLocal <= startLocal) endLocal.setDate(endLocal.getDate() + 1);

    const startISO = startLocal.toISOString();
    const endISO = endLocal.toISOString();
    const location = `${from} → ${to}`;
    if (!(await isDuplicateEvent(activity, startISO, endISO, location))) {
      const description = `
CREATED_BY_GCALJS
Activity: ${activity}
Crew: ${row[idx["Crew"]] || ""}
From: ${from} To: ${to}
STD(L): ${stdLStr} STA(L): ${staLStr}
AcReg: ${row[idx["AcReg"]] || ""} Blockhours: ${row[idx["BLH"]] || ""}
`.trim();

      await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: activity,
          location,
          description,
          start: { dateTime: startISO, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          end: { dateTime: endISO, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        },
      });
      console.log(`✅ 비행 추가: ${activity} (${from}→${to}) [${startISO}]`);
    } else {
      console.log(`⚠️ 중복 비행 스킵: ${activity} (${from}→${to}) [${startISO}]`);
    }
  }

  console.log("✅ Google Calendar 업로드 완료");
})();






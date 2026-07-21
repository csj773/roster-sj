// ==================== kakaoCalendar.js ====================
import fs from "fs";
import path from "path";
import process from "process";

const KAKAO_API_BASE = "https://kapi.kakao.com";
let kakaoAccessToken = process.env.KAKAO_CALENDAR_ACCESS_TOKEN || "";
const KAKAO_REFRESH_TOKEN = process.env.KAKAO_REFRESH_TOKEN || "";
const KAKAO_REST_API_KEY = process.env.KAKAO_REST_API_KEY || "";
const KAKAO_CLIENT_SECRET = process.env.KAKAO_CLIENT_SECRET || "";
const KAKAO_CALENDAR_ID = process.env.KAKAO_CALENDAR_ID || "primary";
const CREATED_TAG = "CREATED_BY_KAKAOCALJS";

if (!kakaoAccessToken && (!KAKAO_REFRESH_TOKEN || !KAKAO_REST_API_KEY)) {
  console.log("ℹ️ Kakao Calendar 토큰 없음: Kakao Talk Calendar 업로드 건너뜀");
  process.exit(0);
}

const AIRPORT_TIMEZONES = {
  ICN: "Asia/Seoul",
  LAX: "America/Los_Angeles",
  SFO: "America/Los_Angeles",
  EWR: "America/New_York",
  NRT: "Asia/Tokyo",
  HKG: "Asia/Hong_Kong",
  DAC: "Asia/Dhaka",
  HNL: "Pacific/Honolulu",
  ESB: "Europe/Istanbul",
  BKK: "Asia/Bangkok",
};

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
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
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
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const tz = AIRPORT_TIMEZONES[airport] || AIRPORT_TIMEZONES.ICN;
  const [year, month, day] = baseDateStr.split("-").map(Number);
  const dayOffset = offset ? Number(offset) : 0;
  const localWallTimeAsUtc = Date.UTC(year, month - 1, day + dayOffset, Number(hh), Number(mm));
  const firstGuess = new Date(localWallTimeAsUtc);
  let offsetMs = getTimeZoneOffsetMs(firstGuess, tz);
  let utcTime = new Date(localWallTimeAsUtc - offsetMs);
  offsetMs = getTimeZoneOffsetMs(utcTime, tz);
  utcTime = new Date(localWallTimeAsUtc - offsetMs);
  return utcTime;
}

function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const m = input.match(/\d{1,2}/);
  if (!m) return null;
  const day = String(m[0]).padStart(2, "0");
  const now = new Date();
  let month = now.getUTCMonth() + 1;
  if (parseInt(day) < now.getUTCDate() - 15) month += 1;
  let year = now.getUTCFullYear();
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return `${year}-${String(month).padStart(2, "0")}-${day}`;
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
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonths(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function nextMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function findMonthMatchingWeekday(year, month, day, weekdayToken) {
  if (!weekdayToken) return null;
  const expected = WEEKDAY_INDEX[weekdayToken];
  if (expected === undefined) return null;
  for (const delta of [0, 1, 2, -1]) {
    const candidate = addMonths(year, month, delta);
    const actual = new Date(Date.UTC(candidate.year, candidate.month - 1, day)).getUTCDay();
    if (actual === expected) return candidate;
  }
  return null;
}

function parseRosterDateText(input) {
  if (!input || typeof input !== "string") return null;
  const dayMatch = input.match(/\d{1,2}/);
  if (!dayMatch) return null;

  let explicitMonth = null;
  let weekday = null;
  const monthMatch = input.match(/\b([A-Za-z]{3,9})\b/g);
  if (monthMatch) {
    for (const token of monthMatch) {
      const key = token.toLowerCase();
      if (MONTH_NAMES[key]) {
        explicitMonth = MONTH_NAMES[key];
        break;
      }
      if (WEEKDAY_INDEX[key] !== undefined) weekday = key;
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

  for (const row of rows) {
    const parsed = parseRosterDateText(row[dateIndex]);
    if (parsed) {
      if (parsed.explicitMonth) {
        if (parsed.explicitMonth < month && month - parsed.explicitMonth > 6) year += 1;
        month = parsed.explicitMonth;
      } else if (lastDay !== null && parsed.hasWeekday && parsed.day < lastDay) {
        const next = nextMonth(year, month);
        year = next.year;
        month = next.month;
      } else if (parsed.weekday) {
        const matched = findMonthMatchingWeekday(year, month, parsed.day, parsed.weekday);
        if (matched) {
          year = matched.year;
          month = matched.month;
        }
      }
      currentDate = formatYMD(year, month, parsed.day);
      lastDay = parsed.day;
    }
    if (currentDate) resolved.set(row, currentDate);
  }
  return resolved;
}

function addDays(ymd, days) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function toKakaoFiveMinuteIso(date, mode) {
  const rounded = new Date(date);
  const ms = rounded.getTime();
  const unitMs = 5 * 60 * 1000;
  const roundedMs = mode === "ceil"
    ? Math.ceil(ms / unitMs) * unitMs
    : Math.floor(ms / unitMs) * unitMs;
  return new Date(roundedMs).toISOString().replace(".000Z", "Z");
}

function formBody(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, value);
  }
  return body;
}

async function kakaoRequest(method, pathname, params = {}) {
  const url = new URL(pathname, KAKAO_API_BASE);
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${kakaoAccessToken}`,
    },
  };

  if (method === "GET" || method === "DELETE") {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  } else {
    options.headers["Content-Type"] = "application/x-www-form-urlencoded;charset=utf-8";
    options.body = formBody(params);
  }

  const response = await fetch(url, options);
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(`Kakao Calendar API 실패: ${method} ${pathname} (${response.status})`);
    error.body = body;
    throw error;
  }
  return body;
}

async function refreshKakaoAccessToken() {
  if (!KAKAO_REFRESH_TOKEN || !KAKAO_REST_API_KEY) return;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: KAKAO_REST_API_KEY,
    refresh_token: KAKAO_REFRESH_TOKEN,
  });
  if (KAKAO_CLIENT_SECRET) body.set("client_secret", KAKAO_CLIENT_SECRET);

  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`Kakao access token 갱신 실패 (${response.status})`);
    error.body = data;
    throw error;
  }
  if (!data.access_token) throw new Error("Kakao token response did not include access_token");

  kakaoAccessToken = data.access_token;
  if (data.refresh_token) {
    console.log("⚠️ Kakao가 새 refresh_token을 발급했습니다. GitHub Secret KAKAO_REFRESH_TOKEN을 새 값으로 교체해야 합니다.");
  }
}

async function insertKakaoEvent(event) {
  return kakaoRequest("POST", "/v2/api/calendar/create/event", {
    calendar_id: KAKAO_CALENDAR_ID,
    event: JSON.stringify(event),
  });
}

async function deleteKakaoEvent(eventId) {
  return kakaoRequest("DELETE", "/v2/api/calendar/delete/event", { event_id: eventId });
}

async function getKakaoEvent(eventId) {
  const body = await kakaoRequest("GET", "/v2/api/calendar/event", { event_id: eventId });
  return body.event || null;
}

async function listKakaoEvents(fromIso, toIso) {
  const events = [];
  let params = {
    calendar_id: KAKAO_CALENDAR_ID,
    from: fromIso,
    to: toIso,
    limit: 1000,
  };

  while (true) {
    const body = await kakaoRequest("GET", "/v2/api/calendar/events", params);
    events.push(...(body.events || []));
    if (!body.has_next || !body.after_url) break;
    const after = new URL(body.after_url);
    params = Object.fromEntries(after.searchParams.entries());
  }
  return events;
}

async function deleteExistingKakaoEvents(dates) {
  if (!dates.length) return;
  console.log("🗑 기존 Kakao Talk Calendar 이벤트 삭제 시작...");
  const sorted = [...dates].sort();
  const events = [];
  let cursor = sorted[0];
  const last = sorted[sorted.length - 1];
  while (cursor <= last) {
    const chunkEnd = addDays(cursor, 30);
    const toDate = chunkEnd > last ? addDays(last, 1) : chunkEnd;
    events.push(...await listKakaoEvents(`${cursor}T00:00:00Z`, `${toDate}T00:00:00Z`));
    cursor = toDate;
  }

  for (const item of events) {
    if (!item.id || item.type !== "USER") continue;
    let detail;
    try {
      detail = await getKakaoEvent(item.id);
    } catch (error) {
      console.error("❌ Kakao 이벤트 상세 조회 실패:", item.id, error.message);
      continue;
    }
    if (!detail?.description?.includes(CREATED_TAG)) continue;
    try {
      await deleteKakaoEvent(item.id);
      console.log(`🗑 Kakao 삭제: ${detail.title || item.title || item.id}`);
    } catch (error) {
      console.error("❌ Kakao 삭제 실패:", detail.title || item.id, error.message);
    }
  }
  console.log("✅ 기존 Kakao Talk Calendar 이벤트 삭제 완료");
}

function buildKakaoEvents(values, headers) {
  const idx = {};
  headers.forEach((h, i) => {
    idx[h] = i;
  });
  const resolvedDates = resolveRosterDateSequence(values.slice(1), idx.Date);
  const kakaoEvents = [];

  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const activity = row[idx.Activity];
    if (!activity || !activity.trim()) continue;

    const convDate = resolvedDates.get(row) || convertDate(row[idx.Date]);
    if (!convDate) continue;

    const from = row[idx.From] || "ICN";
    const to = row[idx.To] || "";
    const stdLStr = row[idx["STD(L)"]] || "0000";
    const staLStr = row[idx["STA(L)"]] || "0000";
    const stdZStr = row[idx["STD(Z)"]] || "";
    const staZStr = row[idx["STA(Z)"]] || "";
    const ciLStr = row[idx["C/I(L)"]] || "0000";
    const blhStr = row[idx.BLH] || "00:00";

    if (/REST|OFF|ETC/i.test(activity) || stdLStr === "0000" || staLStr === "0000") {
      kakaoEvents.push({
        title: activity.slice(0, 50),
        time: {
          start_at: `${convDate}T00:00:00Z`,
          end_at: `${addDays(convDate, 1)}T00:00:00Z`,
          time_zone: "Asia/Seoul",
          all_day: true,
          lunar: false,
        },
        description: `${CREATED_TAG}\nCrew: ${row[idx.Crew] || ""}`,
      });
      continue;
    }

    const startLocal = parseHHMMOffset(stdLStr, convDate, from);
    const endLocal = parseHHMMOffset(staLStr, convDate, to);
    if (!startLocal || !endLocal) continue;
    if (endLocal <= startLocal) endLocal.setDate(endLocal.getDate() + 1);

    const description = `
Activity: ${activity}
From: ${from} To: ${to}
C/I(L): ${ciLStr}
STD(L): ${stdLStr} STA(L): ${staLStr}
STD(Z): ${stdZStr} STA(Z): ${staZStr}
AcReg: ${row[idx.AcReg] || ""}
Blockhours: ${blhStr}
Crew: ${row[idx.Crew] || ""}
${CREATED_TAG}
`.trim();

    kakaoEvents.push({
      title: activity.slice(0, 50),
      time: {
        start_at: toKakaoFiveMinuteIso(startLocal, "floor"),
        end_at: toKakaoFiveMinuteIso(endLocal, "ceil"),
        time_zone: "Asia/Seoul",
        all_day: false,
        lunar: false,
      },
      description,
      location: {
        name: `${from} → ${to}`,
      },
    });
  }

  return kakaoEvents;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  console.log("🚀 Kakao Talk Calendar 업로드 시작");
  await refreshKakaoAccessToken();

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

  const events = buildKakaoEvents(values, values[0]);
  const eventDates = events.map((event) => event.time.start_at.slice(0, 10));
  await deleteExistingKakaoEvents(eventDates);

  for (const event of events) {
    await insertKakaoEvent(event);
    console.log(`✅ Kakao 추가: ${event.title} (${event.time.start_at})`);
    await delay(200);
  }

  console.log("✅ Kakao Talk Calendar 업로드 완료");
})().catch((error) => {
  console.error("❌ Kakao Talk Calendar 업로드 실패:", error.message);
  if (error.body) console.error(JSON.stringify(error.body));
  process.exit(1);
});

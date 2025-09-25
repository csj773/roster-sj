// flightTimeUtils.js

// 문자열 "HHMM" 또는 "HH:MM" -> decimal hour
export function blhStrToHour(str) {
  if (!str) return 0;
  let h = 0, m = 0;
  if (str.includes(":")) {
    [h, m] = str.split(":").map(Number);
  } else if (/^\d{3,4}$/.test(str)) {
    if (str.length === 3) { // e.g. "755"
      h = Number(str[0]);
      m = Number(str.slice(1, 3));
    } else { // "1322"
      h = Number(str.slice(0, 2));
      m = Number(str.slice(2, 4));
    }
  }
  return h + m / 60;
}

// decimal hour -> "HH:MM"
export function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// STD(Z), STA(Z) 문자열 -> Date 객체
// nextDay = true 이면 다음날로 계산
export function parseUTCDate(str, baseDate, nextDay = false) {
  if (!str || !baseDate) return null;
  const date = new Date(baseDate);
  let h = 0, m = 0;
  if (str.includes(":")) {
    [h, m] = str.split(":").map(Number);
  } else if (/^\d{3,4}$/.test(str)) {
    if (str.length === 3) { // e.g. "755"
      h = Number(str[0]);
      m = Number(str.slice(1, 3));
    } else {
      h = Number(str.slice(0, 2));
      m = Number(str.slice(2, 4));
    }
  }
  date.setUTCHours(h, m, 0, 0);
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

// ET: BLH 기준 8시간 초과분
export function calculateET(blhStr) {
  const blh = blhStrToHour(blhStr);
  return blh > 8 ? hourToTimeStr(blh - 8) : "00:00";
}

// NT: STD~STA 구간과 13:00~21:00 UTC 구간 겹치는 시간 계산
export function calculateNT(stdDate, staDate) {
  if (!stdDate || !staDate) return 0;

  let nt = 0;
  let cursor = new Date(stdDate);

  while (cursor < staDate) {
    // 당일 NT 구간
    const nightStart = new Date(cursor);
    nightStart.setUTCHours(13, 0, 0, 0);

    const nightEnd = new Date(cursor);
    nightEnd.setUTCHours(21, 0, 0, 0);

    const start = cursor > nightStart ? cursor : nightStart;
    const end = staDate < nightEnd ? staDate : nightEnd;

    const diff = (end - start) / 1000 / 3600;
    if (diff > 0) nt += diff;

    // 다음날로 이동
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  return nt;
}

// ------------------- Date 변환 함수 -------------------
  function convertDate(input) {
    if (!input || typeof input !== "string") return input;
    const s = input.trim();
    const parts = s.split(/\s+/);
    if (parts.length !== 2) return input;
    const token = parts[0]; 
    const dayStr = parts[1].replace(/^0+/, "") || "0"; 
    if (!/^\d+$/.test(dayStr)) return input;
    const day = parseInt(dayStr, 10); 
    const now = new Date(); 
    const year = now.getFullYear(); 
    const months = { jan:"01", feb:"02", mar:"03", apr:"04", may:"05", jun:"06", jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12" };
    const tokenLower = token.toLowerCase(); 
    if (months[tokenLower]) return `${year}.${months[tokenLower]}.${String(day).padStart(2,"0")}`;
    const weekdays = ["mon","tue","wed","thu","fri","sat","sun"];
    if (weekdays.includes(tokenLower)) {
      const month = String(now.getMonth()+1).padStart(2,"0");
      return `${year}.${month}.${String(day).padStart(2,"0")}`;
    }
    return input;
 

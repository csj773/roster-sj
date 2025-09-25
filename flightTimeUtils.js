// flightTimeUtils.js

// ------------------- BLH 문자열(HHMM 또는 HH:MM) → decimal hour -------------------
export function blhStrToHour(str) {
  if (!str) return 0;
  if (str.includes(":")) {
    const [h, m] = str.split(":").map(Number);
    return h + m / 60;
  } else if (str.length === 4) {
    const h = Number(str.slice(0, 2));
    const m = Number(str.slice(2, 4));
    return h + m / 60;
  }
  return 0;
}

// ------------------- decimal hour → "HH:MM" -------------------
export function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ------------------- UTC 시간 문자열 → Date 객체 -------------------
export function parseUTCDate(timeStr, baseDate, nextDay = false) {
  const [h, m] = timeStr.split(":").map(Number);
  const date = new Date(baseDate);
  date.setUTCHours(h);
  date.setUTCMinutes(m);
  date.setUTCSeconds(0);
  date.setUTCMilliseconds(0);
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

// ------------------- ET 계산 -------------------
export function calculateET(blhStr) {
  const blhHour = blhStrToHour(blhStr);
  return blhHour > 8 ? hourToTimeStr(blhHour - 8) : "00:00";
}

// ------------------- NT 계산 -------------------
export function calculateNT(stdDate, staDate) {
  const nightStart = 13; // 13:00Z
  const nightEnd = 21;   // 21:00Z

  const stdHour = stdDate.getUTCHours() + stdDate.getUTCMinutes() / 60;
  const staHour = staDate.getUTCHours() + staDate.getUTCMinutes() / 60;

  let nt = Math.min(staHour, nightEnd) - Math.max(stdHour, nightStart);
  if (nt < 0) nt = 0;
  return nt;
}

// ------------------- 날짜 변환 -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const s = input.trim();
  const parts = s.split(/\s+/);
  if (parts.length !== 2) return input;

  const token = parts[0];
  const dayStr = parts[1].replace(/^0+/, "") || "0";
  if (!/^\d+$/.test(dayStr)) return input;

  const day = parseInt(dayStr, 10);
  if (day < 1 || day > 31) return input;

  const now = new Date();
  const year = now.getFullYear();

  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04",
    may: "05", jun: "06", jul: "07", aug: "08",
    sep: "09", oct: "10", nov: "11", dec: "12"
  };
  const tokenLower = token.toLowerCase();
  if (months[tokenLower]) {
    return `${year}.${months[tokenLower]}.${String(day).padStart(2, "0")}`;
  }

  const weekdays = ["mon","tue","wed","thu","fri","sat","sun"];
  if (weekdays.includes(tokenLower)) {
    const month = String(now.getMonth() + 1).padStart(2, "0");
    return `${year}.${month}.${String(day).padStart(2, "0")}`;
  }

  return input;
}

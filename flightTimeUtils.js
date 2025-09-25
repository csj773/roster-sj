// ------------------- 문자열 "HHMM" 또는 "HH:MM" → decimal hour -------------------
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

// ------------------- decimal hour → "HH:MM" 문자열 -------------------
export function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ------------------- STD(Z), STA(Z) 문자열 → Date 객체 -------------------
export function parseUTCDate(str, baseDate, nextDay = false) {
  if (!str || !baseDate) return null;
  const date = new Date(baseDate);
  let h = 0, m = 0;

  if (str.includes(":")) {
    [h, m] = str.split(":").map(Number);
  } else if (/^\d{3,4}$/.test(str)) {
    if (str.length === 3) { h = Number(str[0]); m = Number(str.slice(1, 3)); }
    else { h = Number(str.slice(0, 2)); m = Number(str.slice(2, 4)); }
  }

  date.setUTCHours(h, m, 0, 0);
  if (nextDay) date.setUTCDate(date.getUTCDate() + 1);

  return date;
}

// ------------------- ET 계산 (BLH 기준 8시간 초과분) -------------------
export function calculateET(blhStr) {
  const blh = blhStrToHour(blhStr);
  return blh > 8 ? hourToTimeStr(blh - 8) : "00:00";
}

// ------------------- NT 계산 (STD(Z), STA(Z) 기반, 13~21시 기준) -------------------
export function calculateNTFromSTDSTA(stdZ, staZ, flightDate) {
  if (!stdZ || !staZ) return "00:00";

  const stdDate = parseUTCDate(stdZ, flightDate);
  const staDate = parseUTCDate(staZ, flightDate);

  let totalNT = 0;
  let cursor = new Date(stdDate);

  while (cursor < staDate) {
    const ntStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 13, 0, 0));
    const ntEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 21, 0, 0));

    const overlapStart = cursor > ntStart ? cursor : ntStart;
    const overlapEnd = staDate < ntEnd ? staDate : ntEnd;

    const diff = (overlapEnd - overlapStart) / 1000 / 3600; // 시간 단위
    if (diff > 0) totalNT += diff;

    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  return hourToTimeStr(totalNT);
}

// ------------------- Google Sheets용 날짜 변환 -------------------
// 예: "Tue 13" → "YYYY.MM.DD"
export function convertDate(input) {
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

  const months = {
    jan: "01", feb: "02", mar: "03", apr: "04",
    may: "05", jun: "06", jul: "07", aug: "08",
    sep: "09", oct: "10", nov: "11", dec: "12"
  };
  const tokenLower = token.toLowerCase();
  if (months[tokenLower]) return `${year}.${months[tokenLower]}.${String(day).padStart(2,"0")}`;

  const weekdays = ["mon","tue","wed","thu","fri","sat","sun"];
  if (weekdays.includes(tokenLower)) {
    const month = String(now.getMonth()+1).padStart(2,"0");
    return `${year}.${month}.${String(day).padStart(2,"0")}`;
  }

  return input;
}

// ------------------- Crew 문자열 → 배열 -------------------
// 예: "김길주최상준..." → ["김길주","최상준",...]
export function parseCrewString(crewStr) {
  if (!crewStr) return [];
  const regex = /[가-힣]{2,3}/g; // 2~3글자 한글 기준
  return crewStr.match(regex) || [];
}
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

// STD/STA HHMM(+1/-1) 문자열, flightDate: Date 객체 (해당 행 Date)
export function calculateNT(stdStr, staStr, flightDate) {
  if (!stdStr || !staStr) return "00:00";

  // --- STD 처리 ---
  let stdDate = new Date(flightDate);
  let stdH = Number(stdStr.slice(0, 2));
  let stdM = Number(stdStr.slice(2, 4));
  stdDate.setUTCHours(stdH, stdM, 0, 0);
  if (stdStr.includes("+1")) stdDate.setUTCDate(stdDate.getUTCDate() + 1);
  if (stdStr.includes("-1")) stdDate.setUTCDate(stdDate.getUTCDate() - 1);

  // --- STA 처리 ---
  let staDate = new Date(flightDate);
  let staH = Number(staStr.slice(0, 2));
  let staM = Number(staStr.slice(2, 4));
  staDate.setUTCHours(staH, staM, 0, 0);
  if (staStr.includes("+1")) staDate.setUTCDate(staDate.getUTCDate() + 1);
  if (staStr.includes("-1")) staDate.setUTCDate(staDate.getUTCDate() - 1);

  // --- NT 누적 계산 ---
  let totalNT = 0;
  let cursor = new Date(stdDate);

  while (cursor < staDate) {
    const ntStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 13, 0, 0));
    const ntEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 21, 0, 0));

    const overlapStart = cursor > ntStart ? cursor : ntStart;
    const overlapEnd = staDate < ntEnd ? staDate : ntEnd;

    const diff = (overlapEnd - overlapStart) / 1000 / 3600; // 시간 단위
    if (diff > 0) totalNT += diff;

    // 다음 날 00:00로 이동
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  return hourToTimeStr(totalNT);
}


// ET: BLH 기준 8시간 초과분
export function calculateET(blhStr) {
  const blh = blhStrToHour(blhStr);
  return blh > 8 ? hourToTimeStr(blh - 8) : "00:00";
}

// ------------------- NT 계산 -------------------
// STD~STA 구간에서 UTC 13:00~21:00만 합산
// STD/STA는 HHMM(+1/-1) 형식
export function calculateNT(stdHHMM, staHHMM, baseDate) {
  if (!stdHHMM || !staHHMM || !baseDate) return "00:00";

  // HHMM -> Date (UTC) 변환
  const parseHHMMToUTCDate = (str, base) => {
    if (!str) return null;
    let nextDay = 0;
    if (str.endsWith("+1")) { nextDay = 1; str = str.slice(0, -2); }
    else if (str.endsWith("-1")) { nextDay = -1; str = str.slice(0, -2); }

    let h = 0, m = 0;
    if (/^\d{3,4}$/.test(str)) {
      if (str.length === 3) { h = Number(str[0]); m = Number(str.slice(1, 3)); }
      else { h = Number(str.slice(0, 2)); m = Number(str.slice(2, 4)); }
    } else return null;

    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, m, 0));
    if (nextDay !== 0) date.setUTCDate(date.getUTCDate() + nextDay);
    return date;
  };

  const ro = parseHHMMToUTCDate(stdHHMM, baseDate);
  const ri = parseHHMMToUTCDate(staHHMM, baseDate);
  if (!ro || !ri) return "00:00";

  let totalNTMs = 0;
  let cursor = new Date(ro);

  while (cursor < ri) {
    const ntStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 13, 0, 0));
    const ntEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 21, 0, 0));

    const overlapStart = cursor > ntStart ? cursor : ntStart;
    const overlapEnd = ri < ntEnd ? ri : ntEnd;

    if (overlapEnd > overlapStart) totalNTMs += overlapEnd.getTime() - overlapStart.getTime();

    // 다음 날 00:00로 이동
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1, 0, 0, 0));
  }

  const totalMinutes = Math.floor(totalNTMs / 60000);
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minutes = String(totalMinutes % 60).padStart(2, "0");

  return `${hours}:${minutes}`;
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

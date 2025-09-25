// flightTimeUtils.js

/**
 * BLH 문자열 "HH:MM" -> 소수 시간
 */
export function blhStrToHour(blhStr) {
  if (!blhStr || typeof blhStr !== "string") return 0;
  const [h, m] = blhStr.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return 0;
  return h + m / 60;
}

/**
 * 소수 시간 -> "HH:MM" 문자열
 */
export function hourToTimeStr(hour) {
  if (!hour || isNaN(hour)) return "00:00";
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

/**
 * UTC 시간 문자열 "HHMM" 또는 "HHMM+1" -> Date 객체
 */
export function parseUTCDate(timeStr, baseDate, nextDay = false) {
  if (!timeStr || typeof timeStr !== "string") return new Date(baseDate);

  let dayOffset = nextDay || timeStr.includes("+1") ? 1 : 0;
  const cleanStr = timeStr.replace(/\+1$/, "").padStart(4, "0");
  const h = parseInt(cleanStr.slice(0, 2), 10);
  const m = parseInt(cleanStr.slice(2, 4), 10);

  const date = new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayOffset, h, m, 0));
  return date;
}

/**
 * BLH 기준 ET 계산 (8시간 초과분)
 */
export function calculateET(blhStr) {
  const blhHour = blhStrToHour(blhStr);
  return blhHour > 8 ? hourToTimeStr(blhHour - 8) : "00:00";
}

/**
 * NT 계산: flight 구간 중 13:00~21:00 UTC 포함 시간 (시간 단위 소수)
 */
export function calculateNT(stdDate, staDate) {
  const nightStart = new Date(stdDate);
  nightStart.setUTCHours(13, 0, 0, 0);
  const nightEnd = new Date(stdDate);
  nightEnd.setUTCHours(21, 0, 0, 0);

  const flightStart = stdDate;
  const flightEnd = staDate;

  const overlapStart = flightStart > nightStart ? flightStart : nightStart;
  const overlapEnd = flightEnd < nightEnd ? flightEnd : nightEnd;

  const overlapMs = overlapEnd - overlapStart;
  if (overlapMs <= 0) return 0;

  return overlapMs / 1000 / 60 / 60; // 소수 시간 단위 반환
}

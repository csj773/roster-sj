// ------------------- Flight Time Utilities -------------------

// BLH 문자열("HHMM" 또는 "HH:MM") → decimal hour
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

// decimal hour → "HH:MM"
export function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// "HH:MM" → decimal hour
export function timeStrToHour(str) {
  if (!str) return 0;
  const [h, m] = str.split(":").map(Number);
  return h + m / 60;
}

// Extended Time (ET = BLH - 8h, 음수면 0)
export function calculateET(blhStr) {
  const blhHour = blhStrToHour(blhStr || "0000");
  return blhHour > 8 ? hourToTimeStr(blhHour - 8) : "00:00";
}

// NT 계산 (13Z~21Z 구간과 STD~STA 구간의 겹치는 시간)
export function calculateNT(stdDate, staDate) {
  const nightStart = new Date(stdDate);
  nightStart.setUTCHours(13, 0, 0, 0);
  const nightEnd = new Date(stdDate);
  nightEnd.setUTCHours(21, 0, 0, 0);
  const overlapStart = Math.max(stdDate.getTime(), nightStart.getTime());
  const overlapEnd = Math.min(staDate.getTime(), nightEnd.getTime());
  return overlapEnd > overlapStart ? (overlapEnd - overlapStart) / 3600000 : 0;
}

// "HH:MM" 문자열을 UTC Date로 변환
export function parseUTCDate(timeStr, baseDate, isNextDay = false) {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date(baseDate);
  d.setUTCHours(h, m, 0, 0);
  if (isNextDay) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

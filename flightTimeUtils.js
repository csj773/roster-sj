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

  // NT 구간: STD 날짜 기준 13:00~21:00
  const ntStart = new Date(stdDate);
  ntStart.setUTCHours(13, 0, 0, 0);

  const ntEnd = new Date(stdDate);
  ntEnd.setUTCHours(21, 0, 0, 0);

  // STA가 다음 날이면 NT 계산 시 해당 날짜까지 확장
  if (staDate > ntEnd) ntEnd.setUTCDate(staDate.getUTCDate());

  // STD~STA 구간과 NT 구간 겹치는 시간 계산
  const start = stdDate > ntStart ? stdDate : ntStart;
  const end = staDate < ntEnd ? staDate : ntEnd;
  const diff = (end - start) / 1000 / 3600; // 시간 단위

  return diff > 0 ? diff : 0;
}

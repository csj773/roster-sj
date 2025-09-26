// flightTimeUtils.js

// ------------------- BLH 문자열(HH:MM) → 시간(분) -------------------
export function blhStrToHour(blhStr) {
  if (!blhStr) return 0;
  const [h, m] = blhStr.split(":").map(Number);
  return h * 60 + m;
}

// ------------------- 분 → HH:MM -------------------
export function hourToTimeStr(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ------------------- UTC Date 파서 -------------------
// "2025.09.13 1322" → Date 객체 (UTC)
export function parseUTCDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return null;

  const [ymd, hm] = dateStr.split(" ");
  if (!ymd || !hm) return null;

  const [year, month, day] = ymd.split(".").map(Number);
  const h = Number(hm.slice(0, 2));
  const m = Number(hm.slice(2, 4));

  return new Date(Date.UTC(year, month - 1, day, h, m, 0));
}

// ------------------- ET 계산 -------------------
// STD(Z) ~ STA(Z) 사이 비행시간 (분 단위)
export function calculateET(stdStr, staStr) {
  const std = parseUTCDate(stdStr);
  const sta = parseUTCDate(staStr);
  if (!std || !sta) return 0;

  let diff = (sta - std) / 60000; // 분 단위
  if (diff < 0) diff += 24 * 60; // 자정 넘김 보정
  return diff;
}

// ------------------- NT 계산 -------------------
// 야간 시간: 13:00Z ~ 21:00Z
export function calculateNTFromSTDSTA(stdStr, staStr) {
  const std = parseUTCDate(stdStr);
  const sta = parseUTCDate(staStr);
  if (!std || !sta) return 0;

  let nt = 0;
  let cur = new Date(std);

  while (cur < sta) {
    const h = cur.getUTCHours();
    if (h >= 13 && h < 21) {
      nt++;
    }
    cur.setUTCMinutes(cur.getUTCMinutes() + 1);
  }
  return nt;
}

// ------------------- 날짜 변환 (예: "Tue 13" -> "2025.09.13") -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  const s = input.trim();
  const parts = s.split(/\s+/);
  if (parts.length !== 2) return input;
  const token = parts[0]; // 요일 무시
  const dayStr = parts[1].replace(/\D/g, "");
  if (!dayStr) return input;

  const year = new Date().getUTCFullYear();
  const month = String(new Date().getUTCMonth() + 1).padStart(2, "0");
  const day = String(Number(dayStr)).padStart(2, "0");
  return `${year}.${month}.${day}`;
}

// ------------------- 승무원 문자열 파서 -------------------
// "CPT 홍길동/FO 이순신" → ["CPT 홍길동", "FO 이순신"]
export function parseCrewString(crewStr) {
  if (!crewStr) return [];
  return crewStr.split("/").map(s => s.trim()).filter(Boolean);
}


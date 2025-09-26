// ------------------- 문자열 → 시간 변환 -------------------
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

// ------------------- 시간 → 문자열 변환 -------------------
export function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ------------------- ET 계산 -------------------
export function calculateET(blhStr) {
  const blh = blhStrToHour(blhStr);
  return blh > 8 ? hourToTimeStr(blh - 8) : "00:00";
}

// ------------------- NT 계산 (BLH 보정 포함) -------------------
export function calculateNTFromSTDSTA(stdZ, staZ, flightDate, blhStr) {
  if (!stdZ || !staZ) return "00:00";

  // --- STD Date 객체 ---
  let stdDate = new Date(flightDate);
  let stdH = Number(stdZ.slice(0, 2));
  let stdM = Number(stdZ.slice(2, 4));
  stdDate.setUTCHours(stdH, stdM, 0, 0);
  if (stdZ.includes("+1")) stdDate.setUTCDate(stdDate.getUTCDate() + 1);
  if (stdZ.includes("-1")) stdDate.setUTCDate(stdDate.getUTCDate() - 1);

  // --- STA Date 객체 ---
  let staDate = new Date(flightDate);
  let staH = Number(staZ.slice(0, 2));
  let staM = Number(staZ.slice(2, 4));
  staDate.setUTCHours(staH, staM, 0, 0);
  if (staZ.includes("+1")) staDate.setUTCDate(staDate.getUTCDate() + 1);
  if (staZ.includes("-1")) staDate.setUTCDate(staDate.getUTCDate() - 1);

  // --- NT 계산 ---
  let totalNT = 0;
  let cursor = new Date(stdDate);

  while (cursor < staDate) {
    const ntStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 13, 0, 0));
    const ntEnd   = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 21, 0, 0));

    const overlapStart = new Date(Math.max(stdDate, ntStart));
    const overlapEnd   = new Date(Math.min(staDate, ntEnd));

    if (overlapStart < overlapEnd) {
      totalNT += (overlapEnd - overlapStart) / 1000 / 3600;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  // --- BLH 보정 ---
  const blhHour = blhStr ? blhStrToHour(blhStr) : null;
  if (blhHour !== null && totalNT > blhHour) {
    totalNT = blhHour;
  }

  return hourToTimeStr(totalNT);
}

// ------------------- 날짜 변환 -------------------
// "Sep 13" 또는 "Tue 13" → "YYYY.MM.DD"
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

// ------------------- 문자열 → 시간 변환 -------------------
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

// ------------------- 시간 → 문자열 변환 -------------------
export function hourToTimeStr(hour) {
  const h = Math.floor(hour);
  let m = Math.round((hour - h) * 60);
  if (m === 60) return hourToTimeStr(h + 1);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ------------------- ET 계산 -------------------
export function calculateET(blhStr) {
  const blh = blhStrToHour(blhStr);
  return blh > 8 ? hourToTimeStr(blh - 8) : "00:00";
}

// ------------------- NT 계산 (BLH 보정 포함) -------------------
export function calculateNTFromSTDSTA(stdZ, staZ, flightDate, blhStr) {
  if (!stdZ || !staZ) return "00:00";

  // --- STD Date 객체 ---
  let stdDate = new Date(flightDate);
  let stdH = Number(stdZ.slice(0, 2));
  let stdM = Number(stdZ.slice(2, 4));
  stdDate.setUTCHours(stdH, stdM, 0, 0);
  if (stdZ.includes("+1")) stdDate.setUTCDate(stdDate.getUTCDate() + 1);
  if (stdZ.includes("-1")) stdDate.setUTCDate(stdDate.getUTCDate() - 1);

  // --- STA Date 객체 ---
  let staDate = new Date(flightDate);
  let staH = Number(staZ.slice(0, 2));
  let staM = Number(staZ.slice(2, 4));
  staDate.setUTCHours(staH, staM, 0, 0);
  if (staZ.includes("+1")) staDate.setUTCDate(staDate.getUTCDate() + 1);
  if (staZ.includes("-1")) staDate.setUTCDate(staDate.getUTCDate() - 1);

  // --- NT 계산 ---
  let totalNT = 0;
  let cursor = new Date(stdDate);

  while (cursor < staDate) {
    const ntStart = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 13, 0, 0));
    const ntEnd   = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), 21, 0, 0));

    const overlapStart = new Date(Math.max(stdDate, ntStart));
    const overlapEnd   = new Date(Math.min(staDate, ntEnd));

    if (overlapStart < overlapEnd) {
      totalNT += (overlapEnd - overlapStart) / 1000 / 3600;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(0, 0, 0, 0);
  }

  // --- BLH 보정 ---
  const blhHour = blhStr ? blhStrToHour(blhStr) : null;
  if (blhHour !== null && totalNT > blhHour) {
    totalNT = blhHour;
  }

  return hourToTimeStr(totalNT);
}

// ------------------- 날짜 변환 -------------------
// "Sep 13" 또는 "Tue 13" → "YYYY.MM.DD"
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

// ------------------- Crew 문자열 파싱 -------------------
// “긴최배**.." → ["김","최","배",...]
export function parseCrewString(crewStr) {
  if (!crewStr || typeof crewStr !== "string") return [];

  // 성씨 + 1~2글자 이름 (총 2~3글자) 패턴 매칭
  const regex = /(김|이|박|최|정|조|윤|장|임|한|오|서|신|권|황|안|송|류|홍|전|고|문|손|백|허|유|남|심|노|하|곽|성|차|주|우|구|민|진|지|엄|채|원|천|방|공|강)[가-힣]{1,2}/g;

  const matches = crewStr.match(regex);
  return matches ? matches : [];
}

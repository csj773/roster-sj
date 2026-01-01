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

// ------------------- 날짜 → Year/Month 파싱 -------------------

// "Mon 01" 형식 → { Year: "2025", Month: "Sep" }
export function parseYearMonthFromEeeDd(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return { Year: "", Month: "" };

  const weekdays = ["mon","tue","wed","thu","fri","sat","sun"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const now = new Date();
  const year = now.getFullYear();

  const parts = dateStr.trim().split(/\s+/);
  if (parts.length !== 2) return { Year: String(year), Month: "" };

  const token = parts[0].toLowerCase();
  if (!weekdays.includes(token)) return { Year: String(year), Month: "" };

  const month = months[now.getMonth()]; // 현재 월을 Mmm 형태로 반환
  return { Year: String(year), Month: month };
}

// ------------------- Crew 문자열 파싱 -------------------

// 유니코드 한글만 남기는 헬퍼 (입력 정리)
function keepHangulOnly(s) {
  return s ? s.replace(/[^가-힣]/g, "") : "";
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 1글자 성씨(광범위하게 포함)
const singleLastNames = [
  "김","이","박","최","정","조","윤","장","임","한","오","서","선","신","권","황",
  "안","송","류","홍","전","고","문","손","백","허","유","양","남","심","노","하",
  "곽","성","차","주","우","구","민","진","지","엄","염","채","원","천","방","공",
  "강","반","봉","배","반","범","현" // 예시로 요청하신 '반','염','배','범'포함
];

// 두 글자 복성 (필요 시 확장)
const doubleLastNames = [
  "남궁","선우","제갈","독고","황보","사공","선우","서문"
];

// 합치고 중복 제거
const lastNameSet = new Set([...doubleLastNames, ...singleLastNames]);
const lastNamesArr = Array.from(lastNameSet);

// 복성(2글자) 먼저 매칭되도록 길이 내림차순 정렬
lastNamesArr.sort((a,b) => b.length - a.length);

// 정규식 생성 (예: (남궁|제갈|김|이|박)...)[가-힣]{1,2}
const pattern = `(${lastNamesArr.map(escapeRegExp).join("|")})[가-힣]{1,2}`;
const regex = new RegExp(pattern, "g");

// 실제 파서
export function parseCrewString(crewStr) {
  if (!crewStr || typeof crewStr !== "string") return [];

  const input = keepHangulOnly(crewStr);
  const matches = input.match(regex);
  return matches ? matches : [];
  }

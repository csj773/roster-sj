// ========================= perdiem.js =========================
import fs from "fs";
import path from "path";
import admin from "firebase-admin";
import { hourToTimeStr } from "./flightTimeUtils.js";

// ------------------- 공항별 PER DIEM -------------------
export const PERDIEM_RATE = {
  LAX: 3.42, EWR: 3.44, HNL: 3.01, FRA: 3.18, BCN: 3.11,
  NRT: 3.05, ICN: 0.0
};

// ------------------- Date 변환 함수 -------------------
export function convertDate(input) {
  if (!input || typeof input !== "string") {
    const now = new Date();
    return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  }

  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) {
    const now = new Date();
    return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
  }

  const year = new Date().getFullYear();
  const monthMap = {
    Jan:"01",Feb:"02",Mar:"03",Apr:"04",May:"05",Jun:"06",
    Jul:"07",Aug:"08",Sep:"09",Oct:"10",Nov:"11",Dec:"12"
  };

  let month, dayStr;
  if (monthMap[parts[0]]) {
    month = monthMap[parts[0]];
    dayStr = parts[1].padStart(2, "0");
  } else {
    month = String(new Date().getMonth() + 1).padStart(2, "0");
    dayStr = parts[1].padStart(2, "0");
  }

  return `${year}.${month}.${dayStr}`;
}

// ------------------- YYYY.MM.DD → Date 객체 변환 -------------------
export function parseUTCDate(str) {
  if (!str) return null;
  const parts = str.split(".");
  if (parts.length < 3) return null;
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  return new Date(Date.UTC(y, m, d));
}

// ------------------- HHMM ±offset → Date 변환 -------------------
function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = str.match(/^(\d{2})(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseDateParts = baseDateStr.split(".");
  let date = new Date(
    Number(baseDateParts[0]),
    Number(baseDateParts[1]) - 1,
    Number(baseDateParts[2]),
    Number(hh),
    Number(mm)
  );
  if (offset) date.setDate(date.getDate() + Number(offset));
  return date;
}

// ------------------- PER DIEM 계산 -------------------
export function calculatePerDiem(rows) {
  let results = [];
  let prevDateObj = null;
  let grandTotal = 0;

  for (const row of rows) {
    let rawDate = row[0]?.trim();
    let DateFormatted = convertDate(rawDate);         
    let currentDateObj = parseUTCDate(DateFormatted); 

    // --- 롤오버 보정 ---
    if (prevDateObj && currentDateObj < prevDateObj) {
      currentDateObj.setMonth(currentDateObj.getMonth() + 1);
    }
    DateFormatted = `${currentDateObj.getFullYear()}.${String(currentDateObj.getMonth() + 1).padStart(2,"0")}.${String(currentDateObj.getDate()).padStart(2,"0")}`;
    prevDateObj = currentDateObj;

    // ------------------- 이후 로직 -------------------
    const dfParts = DateFormatted.split(".");
    const Year = dfParts[0];
    const Month = dfParts[1];

    const flightNo = row[1];
    const From = row[2];
    const To = row[3];
    const STDZ = row[4]; // 출발시간
    const STAZ = row[5]; // 도착시간

    const rate = PERDIEM_RATE[To] ?? 0;

    // --- RI, RO 계산 ---
    const riDate = parseHHMMOffset(STAZ, DateFormatted);
    const roDate = parseHHMMOffset(STDZ, DateFormatted);

    let StayHours = "0:00";
    let Total = 0;

    if (riDate && roDate && riDate < roDate) {
      const diffHours = (roDate - riDate) / 1000 / 3600;
      StayHours = hourToTimeStr(diffHours);
      Total = Math.round(diffHours * rate * 100) / 100;
    }

    grandTotal += Total;

    results.push({
      Date: DateFormatted,
      Year,
      Month,
      flightNo,
      From,
      To,
      RI: riDate ? riDate.toISOString() : "",
      RO: roDate ? roDate.toISOString() : "",
      StayHours,
      Rate: rate,
      Total
    });
  }

  return { perdiemList: results, GrandTotal: Math.round(grandTotal * 100) / 100 };
}
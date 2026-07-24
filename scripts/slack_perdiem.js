import fs from "fs";
import crypto from "crypto";
import admin from "firebase-admin";
import { hourToTimeStr } from "../flightTimeUtils.js";

export const SLACK_PERDIEM_RATE = {
  EWR: 3.44,
  LAX: 3.42,
  SFO: 3.42,
  LAS: 3.42,
  IAD: 3.42,
  HNL: 3.42,
  ADD: 3.44,
  JUB: 3.44,
  NRT: 2.75,
  HKG: 2.75,
  SIN: 2.75,
  BKK: 2.14,
  DAC: 2.14,
  DAD: 2.01,
  OSL: 3.24,
  ESB: 3.00,
  AUH: 2.41,
  BEY: 2.41,
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAME_TO_NUMBER = Object.fromEntries(MONTH_NAMES.map((name, index) => [name.toLowerCase(), index + 1]));
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TRANSPORT_FEE_PER_FLIGHT = 7000;
const QUICK_TURN_THRESHOLD_HOURS = 12;
const QUICK_TURN_MINIMUM_TOTAL = 33;
const FLIGHT_ACTIVITY_RE = /^YP\d+/i;
const PERDIEM_COLLECTION = String(process.env.PERDIEM_COLLECTION || "Perdiem").trim();
const DUPLICATE_TIME_TOLERANCE_MINUTES = Number(process.env.PERDIEM_DEDUPE_TOLERANCE_MINUTES || 15);

function normalizeAirportCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function convertDate(input) {
  if (!input || typeof input !== "string") return input;
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(input.trim())) return input.trim();

  const parts = input.trim().split(/\s+/);
  if (parts.length < 2) return input;

  const now = new Date();
  const year = now.getUTCFullYear();
  const monthMap = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };

  const month = monthMap[parts[0]] || String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = parts[1].padStart(2, "0");
  return `${year}.${month}.${day}`;
}

function parseHHMMOffset(str, baseDateStr) {
  if (!str) return null;
  const match = String(str).trim().match(/^(\d{1,2}):?(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const [, hh, mm, offset] = match;
  const baseDateParts = String(baseDateStr || "").split(".");
  const dayOffset = offset ? Number(offset) : 0;
  return new Date(Date.UTC(
    Number(baseDateParts[0]),
    Number(baseDateParts[1]) - 1,
    Number(baseDateParts[2]) + dayOffset,
    Number(hh),
    Number(mm)
  ));
}

function formatDateDots(year, month, day) {
  return `${year}.${String(month).padStart(2, "0")}.${String(day).padStart(2, "0")}`;
}

function incrementMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function addMonths(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function findMonthMatchingWeekday(year, month, day, weekdayToken) {
  const expected = WEEKDAY_INDEX[weekdayToken];
  if (expected === undefined) return null;

  for (const delta of [0, 1, 2, -1]) {
    const candidate = addMonths(year, month, delta);
    const actual = new Date(Date.UTC(candidate.year, candidate.month - 1, day)).getUTCDay();
    if (actual === expected) return candidate;
  }
  return null;
}

function parseRosterDateText(input) {
  if (!input || typeof input !== "string") return null;
  const normalized = input.trim();
  const dotDate = normalized.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})$/);
  if (dotDate) {
    return {
      day: Number(dotDate[3]),
      explicitMonth: Number(dotDate[2]),
      explicitYear: Number(dotDate[1]),
      weekday: null,
    };
  }

  const dayMatch = normalized.match(/\d{1,2}/);
  if (!dayMatch) return null;

  let explicitMonth = null;
  let weekday = null;
  const tokens = normalized.match(/\b([A-Za-z]{3,9})\b/g) || [];
  for (const token of tokens) {
    const key = token.toLowerCase();
    if (MONTH_NAME_TO_NUMBER[key]) {
      explicitMonth = MONTH_NAME_TO_NUMBER[key];
      break;
    }
    if (WEEKDAY_INDEX[key] !== undefined) weekday = key;
  }

  return { day: Number(dayMatch[0]), explicitMonth, explicitYear: null, weekday };
}

function resolveRosterDateSequence(rows, dateIndex = 0) {
  const resolved = new WeakMap();
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1;
  let lastDay = null;
  let currentDate = null;

  for (const row of rows) {
    const parsed = parseRosterDateText(row[dateIndex]);

    if (parsed) {
      if (parsed.explicitYear) year = parsed.explicitYear;
      if (parsed.explicitMonth) {
        if (!parsed.explicitYear && parsed.explicitMonth < month && month - parsed.explicitMonth > 6) year += 1;
        month = parsed.explicitMonth;
      } else if (lastDay !== null && parsed.weekday && parsed.day < lastDay) {
        ({ year, month } = incrementMonth(year, month));
      } else if (parsed.weekday) {
        const matched = findMonthMatchingWeekday(year, month, parsed.day, parsed.weekday);
        if (matched) ({ year, month } = matched);
      }

      currentDate = formatDateDots(year, month, parsed.day);
      lastDay = parsed.day;
    }

    if (currentDate) resolved.set(row, currentDate);
  }

  return resolved;
}

function monthYearFromRosterDate(fallbackDateFormatted) {
  const dfParts = String(fallbackDateFormatted || "").split(".");
  const monthIndex = Number(dfParts[1] || "1") - 1;
  return {
    Year: dfParts[0] || String(new Date().getUTCFullYear()),
    Month: MONTH_NAMES[monthIndex] || "Unknown",
  };
}

function monthYearFromLocalTime(localTimeText, baseDateFormatted) {
  const localDate = parseHHMMOffset(localTimeText, baseDateFormatted);
  if (!localDate || Number.isNaN(localDate.valueOf())) return monthYearFromRosterDate(baseDateFormatted);

  return {
    Year: String(localDate.getUTCFullYear()),
    Month: MONTH_NAMES[localDate.getUTCMonth()] || "Unknown",
  };
}

function calculatePerDiem(riDate, roDate, rate) {
  if (!riDate || !roDate || riDate >= roDate) return { StayHours: "0:00", Total: 0, Hours: 0 };
  const diffHours = (roDate - riDate) / 1000 / 3600;
  const total = Math.round(diffHours * rate * 100) / 100;
  return { StayHours: hourToTimeStr(diffHours), Total: total, Hours: diffHours };
}

function calculateQuickTurnTotal(rate) {
  return Math.round(Math.max(rate * 24 * 0.5, QUICK_TURN_MINIMUM_TOTAL) * 100) / 100;
}

function rateForAirport(airportCode) {
  const normalized = normalizeAirportCode(airportCode);
  if (normalized === "ICN") return 0;
  return SLACK_PERDIEM_RATE[normalized] || 3;
}

function hoursFromTimeString(value) {
  const match = String(value || "").trim().match(/^(\d+):(\d{1,2})$/);
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60;
}

function dateSortKey(value) {
  const match = String(value || "").match(/^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/);
  if (!match) return String(value || "");
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function dateUtcMs(value) {
  const match = dateSortKey(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function daysBetweenDates(left, right) {
  const leftMs = dateUtcMs(left);
  const rightMs = dateUtcMs(right);
  if (leftMs === null || rightMs === null) return Number.POSITIVE_INFINITY;
  return Math.abs(leftMs - rightMs) / 86400000;
}

function calculateTotalFromHours(hours, rate, destination) {
  if (!Number.isFinite(hours) || hours <= 0 || rate <= 0) return 0;
  if (normalizeAirportCode(destination) === "ICN" && hours < QUICK_TURN_THRESHOLD_HOURS) {
    return calculateQuickTurnTotal(rate);
  }
  return Math.round(hours * rate * 100) / 100;
}

function normalizeSlackPerDiemItem(item) {
  const From = normalizeAirportCode(item.From) || "UNKNOWN";
  const Destination = normalizeAirportCode(item.Destination) || "UNKNOWN";
  const Rate = rateForAirport(From);
  const hours = hoursFromTimeString(item.StayHours);
  const Total = From === "ICN" ? 0 : calculateTotalFromHours(hours, Rate, Destination);
  return {
    ...item,
    From,
    Destination,
    Rate,
    Total,
  };
}


function rosterTimeInstant(row, fieldNames) {
  for (const fieldName of fieldNames) {
    const value = row?.[fieldName];
    if (!value) continue;
    const parsed = parseHHMMOffset(value, row.Date);
    if (parsed instanceof Date && !Number.isNaN(parsed.valueOf())) return parsed;
  }
  return null;
}

function rowDepartureInstant(row) {
  // UTC 시간이 있으면 우선 사용하고, 없으면 현지 시간을 사용한다.
  // STDZ/STDL 뒤의 +1/-1은 row.Date 기준 다음 날/전날을 뜻한다.
  return rosterTimeInstant(row, ["STDZ", "STDL"]);
}

function rowArrivalInstant(row) {
  return rosterTimeInstant(row, ["STAZ", "STAL"]);
}

function sameFlightIdentity(left, right) {
  return [
    left.Activity,
    left.From,
    left.Destination,
  ].join("|") === [
    right.Activity,
    right.From,
    right.Destination,
  ].join("|");
}

function minutesBetween(left, right) {
  if (!(left instanceof Date) || Number.isNaN(left.valueOf())) return Number.POSITIVE_INFINITY;
  if (!(right instanceof Date) || Number.isNaN(right.valueOf())) return Number.POSITIVE_INFINITY;
  return Math.abs(left.valueOf() - right.valueOf()) / 60000;
}

function sameAbsoluteRosterEvent(left, right) {
  if (!sameFlightIdentity(left, right)) return false;
  if (daysBetweenDates(left.Date, right.Date) > 1) return false;

  const leftDeparture = rowDepartureInstant(left);
  const rightDeparture = rowDepartureInstant(right);
  if (minutesBetween(leftDeparture, rightDeparture) <= DUPLICATE_TIME_TOLERANCE_MINUTES) {
    return true;
  }

  const leftArrival = rowArrivalInstant(left);
  const rightArrival = rowArrivalInstant(right);
  if (minutesBetween(leftArrival, rightArrival) <= DUPLICATE_TIME_TOLERANCE_MINUTES) {
    return true;
  }

  // RI/RO가 이미 계산되어 같은 절대시각을 가리키면 동일 이벤트로 본다.
  if (left.RI && right.RI && left.RI === right.RI) return true;
  if (left.RO && right.RO && left.RO === right.RO) return true;

  return false;
}

function rowCompletenessScore(row) {
  return [
    row.STDL,
    row.STDZ,
    row.STAL,
    row.STAZ,
    row.RI,
    row.RO,
    row.StayHours,
  ].filter(Boolean).length;
}

function preferredDuplicateRow(current, candidate) {
  if (!current) return candidate;

  const currentScore = rowCompletenessScore(current);
  const candidateScore = rowCompletenessScore(candidate);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }

  // 두 문서의 정보 수준이 같으면 현지 운항일 기준 더 이른 날짜를 유지한다.
  const currentDate = dateSortKey(current.Date);
  const candidateDate = dateSortKey(candidate.Date);
  if (candidateDate !== currentDate) {
    return candidateDate < currentDate ? candidate : current;
  }

  return current;
}

function dedupePerDiemRows(rows) {
  const sorted = [...rows].sort((a, b) => {
    const identityCompare = [
      a.Activity,
      a.From,
      a.Destination,
    ].join("|").localeCompare([
      b.Activity,
      b.From,
      b.Destination,
    ].join("|"));
    if (identityCompare !== 0) return identityCompare;
    return dateSortKey(a.Date).localeCompare(dateSortKey(b.Date));
  });

  const result = [];
  for (const row of sorted) {
    const duplicateIndex = result.findIndex((saved) => sameAbsoluteRosterEvent(saved, row));
    if (duplicateIndex < 0) {
      result.push(row);
      continue;
    }
    result[duplicateIndex] = preferredDuplicateRow(result[duplicateIndex], row);
  }

  return result.sort((a, b) => {
    const dateCompare = dateSortKey(a.Date).localeCompare(dateSortKey(b.Date));
    if (dateCompare !== 0) return dateCompare;
    return String(a.Activity || "").localeCompare(String(b.Activity || ""));
  });
}

function filterUnusedOutboundRows(rows) {
  const inboundRows = rows.filter((row) => row.Destination === "ICN" && row.From !== "ICN");
  const usedRi = new Set(inboundRows.map((row) => row.RI).filter(Boolean));
  const lastInboundDate = inboundRows
    .map((row) => dateSortKey(row.Date))
    .sort()
    .at(-1) || "";

  return rows.filter((row) => {
    if (row.From !== "ICN") return true;
    if (row.RI && usedRi.has(row.RI)) return true;
    return lastInboundDate && dateSortKey(row.Date) > lastInboundDate;
  });
}

function normalizeSlackPerDiemRows(rows) {
  // 출발편과 귀국편 모두 실제 출발/도착 절대시각을 기준으로 중복 제거한다.
  return filterUnusedOutboundRows(dedupePerDiemRows(rows));
}

export async function generateSlackPerDiemList(rosterJsonPath) {
  const raw = JSON.parse(fs.readFileSync(rosterJsonPath, "utf-8"));
  const rows = raw.values.slice(1);
  const resolvedDates = resolveRosterDateSequence(rows);
  const resolvedDateForRow = (row) => resolvedDates.get(row) || convertDate(row[0]);

  const perdiemList = [];
  const now = new Date();
  const flightRows = rows.filter((row) => {
    const activity = String(row[4] || "").trim().toUpperCase();
    const from = String(row[6] || "").trim();
    const to = String(row[9] || "").trim();
    return FLIGHT_ACTIVITY_RE.test(activity) && from && to && from !== to;
  });

  const findPreviousOutboundArrival = (currentIndex, station, beforeDate) => {
    let best = null;
    for (let j = currentIndex - 1; j >= 0; j -= 1) {
      const previousRow = flightRows[j];
      const previousFrom = normalizeAirportCode(previousRow[6]);
      const previousTo = normalizeAirportCode(previousRow[9]);
      if (previousFrom !== "ICN" || previousTo !== station) continue;

      const arrival = parseHHMMOffset(previousRow[11], resolvedDateForRow(previousRow));
      if (!(arrival instanceof Date) || Number.isNaN(arrival.valueOf())) continue;
      if (beforeDate instanceof Date && !Number.isNaN(beforeDate.valueOf()) && arrival > beforeDate) continue;
      if (!best || arrival > best.date) best = { date: arrival, row: previousRow };
    }
    return best;
  };

  for (let i = 0; i < flightRows.length; i += 1) {
    const row = flightRows[i];
    const [, , , , activity, , fromRaw, stdl, stdz, toRaw, stal, staz] = row;
    const from = normalizeAirportCode(fromRaw) || "UNKNOWN";
    const to = normalizeAirportCode(toRaw) || "UNKNOWN";

    let localDateFormatted = resolvedDateForRow(row);
    let dateFormatted = localDateFormatted;
    if (!dateFormatted || !dateFormatted.includes(".")) {
      dateFormatted = i > 0 ? resolvedDateForRow(flightRows[i - 1])
        : `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, "0")}.${String(now.getUTCDate()).padStart(2, "0")}`;
      localDateFormatted = dateFormatted;
    }

    let rate = rateForAirport(from);
    let riDate = null;
    let roDate = null;

    if (to === "ICN" && from !== "ICN") {
      roDate = parseHHMMOffset(stdz || staz, dateFormatted);
      const previousOutbound = findPreviousOutboundArrival(i, from, roDate);
      if (previousOutbound) riDate = previousOutbound.date;
    } else if (from === "ICN") {
      riDate = parseHHMMOffset(staz, dateFormatted);
    } else {
      riDate = parseHHMMOffset(staz, dateFormatted);
      roDate = parseHHMMOffset(stdz, dateFormatted);
    }

    if (to === "ICN" && from !== "ICN" && i > 0) {
      const previousRow = flightRows[i - 1];
      if (normalizeAirportCode(previousRow[6]) === "ICN" && normalizeAirportCode(previousRow[9]) === from) {
        const previousArrival = parseHHMMOffset(previousRow[11], resolvedDateForRow(previousRow));
        if (previousArrival instanceof Date && !Number.isNaN(previousArrival.valueOf())) {
          riDate = previousArrival;
          if (!String(row[0] || "").trim()) dateFormatted = resolvedDateForRow(previousRow);
        }
      }
    }

    const riValid = riDate instanceof Date && !Number.isNaN(riDate.valueOf()) ? riDate : null;
    const roValid = roDate instanceof Date && !Number.isNaN(roDate.valueOf()) ? roDate : null;
    let { StayHours, Total, Hours } = calculatePerDiem(riValid, roValid, rate);

    if (from === "ICN") {
      StayHours = "0:00";
      rate = 0;
      Total = 0;
    }
    if (to === "ICN" && from !== "ICN" && Hours > 0 && Hours < QUICK_TURN_THRESHOLD_HOURS) {
      Total = calculateQuickTurnTotal(rate);
    }

    const assigned = monthYearFromLocalTime(stdl, localDateFormatted);
    perdiemList.push(normalizeSlackPerDiemItem({
      Date: dateFormatted,
      Activity: activity,
      From: from,
      Destination: to,
      STDL: stdl,
      STDZ: stdz,
      STAL: stal,
      STAZ: staz,
      RI: riValid ? riValid.toISOString() : "",
      RO: roValid ? roValid.toISOString() : "",
      StayHours,
      Rate: rate,
      Total,
      TransportFee: TRANSPORT_FEE_PER_FLIGHT,
      Month: assigned.Month,
      Year: assigned.Year,
    }));
  }

  return normalizeSlackPerDiemRows(perdiemList);
}

function cleanOwnerValue(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function perDiemDocId(owner, item) {
  return crypto.createHash("sha256").update([
    owner,
    item.Date,
    item.Activity,
    item.From,
    item.Destination,
  ].join("|")).digest("hex");
}

async function commitDeleteRefs(db, refs) {
  let deleted = 0;
  for (let index = 0; index < refs.length; index += 400) {
    const batch = db.batch();
    const chunk = refs.slice(index, index + 400);
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
    deleted += chunk.length;
  }
  return deleted;
}

async function commitPerDiemWrites(db, collectionName, docs) {
  let written = 0;
  for (let index = 0; index < docs.length; index += 400) {
    const batch = db.batch();
    const chunk = docs.slice(index, index + 400);
    for (const { id, data } of chunk) {
      batch.set(db.collection(collectionName).doc(id), data, { merge: false });
    }
    await batch.commit();
    written += chunk.length;
  }
  return written;
}

/**
 * 해당 사용자(owner)의 Perdiem 문서만 삭제한 뒤 새 목록으로 재작성한다.
 * 다른 사용자의 문서는 건드리지 않는다.
 */
export async function rewriteUserPerDiem(
  db,
  perdiemList,
  {
    owner,
    uid,
    userId,
    email = "",
    displayName = "",
    collectionName = PERDIEM_COLLECTION,
  } = {}
) {
  if (!db) throw new Error("Firestore db is required");

  const resolvedOwner = cleanOwnerValue(owner || uid || userId);
  if (!resolvedOwner) {
    throw new Error("owner, uid, or userId is required for user-specific Perdiem rewrite");
  }

  const normalizedRows = normalizeSlackPerDiemRows(perdiemList || []);
  const existingSnapshot = await db
    .collection(collectionName)
    .where("owner", "==", resolvedOwner)
    .get();

  const deleted = await commitDeleteRefs(
    db,
    existingSnapshot.docs.map((doc) => doc.ref)
  );

  const now = admin.firestore.FieldValue.serverTimestamp();
  const writes = normalizedRows.map((item) => ({
    id: perDiemDocId(resolvedOwner, item),
    data: {
      ...item,
      owner: resolvedOwner,
      uid: cleanOwnerValue(uid || resolvedOwner),
      userId: cleanOwnerValue(userId || uid || resolvedOwner),
      email: cleanOwnerValue(email, 240),
      display_name: cleanOwnerValue(displayName, 200),
      pdc_user_name: cleanOwnerValue(displayName, 200),
      updatedAt: now,
      importedAt: now,
    },
  }));

  const written = await commitPerDiemWrites(db, collectionName, writes);
  return {
    owner: resolvedOwner,
    collectionName,
    deleted,
    written,
    skippedDuplicates: (perdiemList || []).length - normalizedRows.length,
  };
}

/**
 * roster JSON을 읽어 Perdiem을 생성하고, 해당 사용자 문서만 rewrite한다.
 */
export async function generateAndRewriteSlackPerDiem(
  db,
  rosterJsonPath,
  ownerOptions = {}
) {
  const perdiemList = await generateSlackPerDiemList(rosterJsonPath);
  return rewriteUserPerDiem(db, perdiemList, ownerOptions);
}


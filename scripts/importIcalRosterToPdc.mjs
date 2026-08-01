import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import admin from "firebase-admin";
import { generateAndRewriteSlackPerDiem } from "./slack_perdiem.js";

const PDC_COLLECTION = "pdc";
const PDC_FLAT_MIRROR_COLLECTION = "PdcEvents";
const PERDIEM_COLLECTION = "Perdiem";
const SLACK_ICAL_SOURCE = "slack_ical";
const ROSTER_HEADERS = ["Date", "DC", "C/I(L)", "C/O(L)", "Activity", "F", "From", "STD(L)", "STD(Z)", "To", "STA(L)", "STA(Z)", "BLH", "AcReg", "Crew"];

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name) {
  return String(process.env[name] || "").trim();
}

function parseJsonEnv(name) {
  const raw = requiredEnv(name)
    .replace(/^\uFEFF/, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/-----BEGIN PRIVATE KEY[—–-]+/g, "-----BEGIN PRIVATE KEY-----")
    .replace(/[—–-]+END PRIVATE KEY[—–-]+/g, "-----END PRIVATE KEY-----");
  const parsed = JSON.parse(raw);
  if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  return parsed;
}

function cleanText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function displayNameForEmail(email) {
  const normalizedEmail = cleanText(email, 240).toLowerCase();
  const displayNames = {
    "csj773@yahoo.co.kr": "최상준",
    "cutecsj773@gmail.com": "최상준",
    "sjchoi787@gmail.com": "최상준",
  };
  return displayNames[normalizedEmail] || "";
}

async function enrichOwnerFromUsersDoc(db, owner) {
  const uid = cleanText(owner?.uid || "", 500);
  if (!uid || uid.startsWith("guest_")) return owner;

  const snap = await db.collection("users").doc(uid).get();
  const data = snap.exists ? snap.data() || {} : {};
  const email = cleanText(data.email || owner.email, 240).toLowerCase();
  const mappedDisplayName = displayNameForEmail(email);
  return {
    ...owner,
    email,
    displayName:
      mappedDisplayName ||
      cleanText(data.display_name || data.displayName || data.name, 200) ||
      cleanText(owner.displayName, 200),
  };
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

const PDC_HASH_SKIP_FIELDS = new Set([
  "createdAt",
  "importedAt",
  "rewrittenAt",
  "updatedAt",
  "sourceHash",
  "sourceHashUpdatedAt",
]);

function stableHashValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableHashValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => !PDC_HASH_SKIP_FIELDS.has(key))
      .sort()
      .map((key) => [key, stableHashValue(value[key])]));
  }
  return value;
}

function sourceHashForDocEntries(entries) {
  const stableEntries = entries
    .map(({ id, data }) => ({ id, data: stableHashValue(data) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return hashText(JSON.stringify(stableEntries));
}

function ownerPdcDocId(ownerUid) {
  return cleanText(ownerUid, 500).replace(/\//g, "_") || "unknown_owner";
}

function pdcEventDocId(docData) {
  return hashText([
    docData.owner,
    docData.Date,
    docData.DC,
    docData.Activity,
    docData.From,
    docData.To,
  ].join("|"));
}

function crewKey(docData) {
  const crewArray = Array.isArray(docData.CrewArray) ? docData.CrewArray : [];
  return crewArray.map((name) => cleanText(name, 40)).filter(Boolean).sort().join(",");
}

function importDuplicateKey(docData) {
  // Crew 정보는 iCal 이벤트마다 표기 순서/누락이 달라질 수 있으므로
  // 동일 비행편 중복 판정 키에서 제외합니다.
  return [
    docData.owner,
    cleanText(docData.DC, 20).toUpperCase(),
    cleanText(docData.Activity || docData.F, 80).replace(/\s+/g, "").toUpperCase(),
    cleanText(docData.From, 10).toUpperCase(),
    cleanText(docData.To, 10).toUpperCase(),
  ].join("|");
}

function dateNumber(value) {
  const match = cleanText(value, 20).match(/^(\d{4})[.-](\d{2})[.-](\d{2})$/);
  if (!match) return Number.NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000;
}

function parseRosterTime(value) {
  const text = cleanText(value, 40).replace(/\s+/g, "");
  const match = text.match(/^(\d{1,2}):?(\d{2})([+-]\d+)?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const dayOffset = Number(match[3] || 0);
  if (hour > 23 || minute > 59) return null;
  return {
    hour,
    minute,
    dayOffset,
    minutes: hour * 60 + minute,
    normalized: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}${dayOffset ? `${dayOffset > 0 ? "+" : ""}${dayOffset}` : ""}`,
  };
}

function departureTime(docData, zone = "L") {
  if (zone === "Z") {
    return parseRosterTime(docData.STDZ || docData["STD(Z)"] || "");
  }
  return parseRosterTime(docData.STDL || docData["STD(L)"] || "");
}

function circularMinuteDifference(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const direct = Math.abs(a.minutes - b.minutes);
  return Math.min(direct, 1440 - direct);
}

function looksLikeSameRosterEvent(a, b) {
  if (importDuplicateKey(a) !== importDuplicateKey(b)) return false;

  const aDate = dateNumber(a.Date);
  const bDate = dateNumber(b.Date);
  if (!Number.isFinite(aDate) || !Number.isFinite(bDate)) return false;

  const dayDiff = Math.abs(aDate - bDate);
  if (dayDiff === 0) return true;
  if (dayDiff !== 1) return false;

  const aLocal = departureTime(a, "L");
  const bLocal = departureTime(b, "L");
  const aZulu = departureTime(a, "Z");
  const bZulu = departureTime(b, "Z");

  // 동일한 비행편이 현지 날짜와 UTC 날짜로 각각 생성되는 경우를 제거합니다.
  // 2026.07.06 HNL-ICN / 2026.07.07 HNL-ICN처럼 날짜만 하루 차이나고
  // 출발시각이 같은 이벤트는 동일 이벤트로 판단합니다.
  const sameLocalTime = circularMinuteDifference(aLocal, bLocal) <= 15;
  const sameZuluTime = circularMinuteDifference(aZulu, bZulu) <= 15;
  if (sameLocalTime || sameZuluTime) return true;

  // 한 이벤트는 23~24시, 다른 이벤트는 00~04시로 표현되는 자정 경계 중복도 허용합니다.
  const times = [aLocal, bLocal, aZulu, bZulu].filter(Boolean);
  return times.some((time) => time.minutes >= 20 * 60) &&
    times.some((time) => time.minutes <= 4 * 60);
}

function duplicateCompletenessScore(docData) {
  const fields = [
    docData.STDL, docData.STAL, docData.STDZ, docData.STAZ,
    docData.Crew, docData.RI, docData.RO, docData.sourceDescription,
  ];
  return fields.reduce((score, value) => score + (cleanText(value, 2000) ? 1 : 0), 0);
}

function preferredDuplicateDoc(current, candidate) {
  if (!current) return candidate;

  const currentScore = duplicateCompletenessScore(current);
  const candidateScore = duplicateCompletenessScore(candidate);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }

  const currentDay = dateNumber(current.Date);
  const candidateDay = dateNumber(candidate.Date);

  // 동일 편이 현지일과 UTC일로 하루 차이 나면 더 이른 날짜를 운항일로 유지합니다.
  // 예: HNL 7/6 출발편이 UTC 기준 7/7로 중복 생성되는 경우 7/6을 보존합니다.
  if (Number.isFinite(currentDay) && Number.isFinite(candidateDay) && currentDay !== candidateDay) {
    return candidateDay < currentDay ? candidate : current;
  }

  return cleanText(candidate.sourceDescription, 2000).length > cleanText(current.sourceDescription, 2000).length
    ? candidate
    : current;
}

function dedupeImportDocs(docs) {
  const groups = [];
  for (const docData of docs) {
    const group = groups.find((items) => items.some((item) => looksLikeSameRosterEvent(item, docData)));
    if (group) {
      group.push(docData);
    } else {
      groups.push([docData]);
    }
  }
  return groups.map((items) => items.reduce(preferredDuplicateDoc, null));
}

async function commitInChunks(db, operations, chunkSize = 400) {
  for (let i = 0; i < operations.length; i += chunkSize) {
    const batch = db.batch();
    for (const operation of operations.slice(i, i + chunkSize)) operation(batch);
    await batch.commit();
  }
}

async function deleteExistingOwnerPdcDocs(db, ownerUid) {
  const owner = cleanText(ownerUid, 500);
  if (!owner) throw new Error("owner uid is required for per-diem rewrite");

  const refs = new Map();

  // 평면 pdc 문서 중 현재 사용자(owner) 자료만 삭제합니다.
  const flatSnapshot = await db.collection(PDC_COLLECTION).where("owner", "==", owner).get();
  for (const doc of flatSnapshot.docs) refs.set(doc.ref.path, doc.ref);

  const mirrorSnapshot = await db.collection(PDC_FLAT_MIRROR_COLLECTION).where("owner", "==", owner).get();
  for (const doc of mirrorSnapshot.docs) refs.set(doc.ref.path, doc.ref);

  // 사용자 문서 아래 events도 현재 사용자 것만 삭제합니다.
  const ownerRef = db.collection(PDC_COLLECTION).doc(ownerPdcDocId(owner));
  const eventsSnapshot = await ownerRef.collection("events").get();
  for (const doc of eventsSnapshot.docs) refs.set(doc.ref.path, doc.ref);

  const csvRowsSnapshot = await ownerRef.collection("csvRows").get();
  for (const doc of csvRowsSnapshot.docs) refs.set(doc.ref.path, doc.ref);

  // 다른 사용자의 pdc 자료는 건드리지 않습니다.
  await commitInChunks(db, [...refs.values()].map((ref) => (batch) => batch.delete(ref)));
  return refs.size;
}

function fetchableCalendarUrl(value) {
  const text = cleanText(value, 1000).replace(/[*>.,;)\]]+$/g, "");
  if (/^webcal:\/\//i.test(text)) return `https://${text.slice("webcal://".length)}`;
  if (/^https:\/\//i.test(text)) return text;
  return "";
}

function unfoldIcsLines(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

function decodeIcsText(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseIcsValue(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const keyPart = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = keyPart.split(";");
  const params = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  return { name: name.toUpperCase(), params, value };
}

function parseIcsEvents(text) {
  const events = [];
  let current = null;
  for (const line of unfoldIcsLines(text)) {
    if (line.trim() === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line.trim() === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseIcsValue(line);
    if (!parsed) continue;
    current[parsed.name] = {
      params: parsed.params,
      value: decodeIcsText(parsed.value),
    };
  }
  return events;
}

function parseIcsDate(value) {
  const text = cleanText(value, 40);
  const match = text.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/);
  if (!match) return { date: "", time: "" };
  const iso = match[4]
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`
    : `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`;
  return {
    date: `${match[1]}.${match[2]}.${match[3]}`,
    time: match[4] ? `${match[4]}:${match[5]}` : "",
    iso,
  };
}

function minutesFromColonTime(value) {
  const match = cleanText(value, 20).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function timeWithDateOffset(start, end) {
  if (!end.time) return "";
  const startMinutes = minutesFromColonTime(start.time);
  const endMinutes = minutesFromColonTime(end.time);
  const dayOffset = start.date && end.date
    ? Math.round((Date.parse(end.date.replace(/\./g, "-")) - Date.parse(start.date.replace(/\./g, "-"))) / 86400000)
    : 0;
  if (dayOffset > 0) return `${end.time}+${dayOffset}`;
  if (dayOffset < 0) return `${end.time}${dayOffset}`;
  return startMinutes !== null && endMinutes !== null && endMinutes <= startMinutes
    ? `${end.time}+1`
    : end.time;
}

function compactTimeWithOffset(value) {
  const parsed = parseRosterTime(value);
  if (!parsed) return cleanText(value, 40);
  return `${String(parsed.hour).padStart(2, "0")}${String(parsed.minute).padStart(2, "0")}${parsed.dayOffset ? `${parsed.dayOffset > 0 ? "+" : ""}${parsed.dayOffset}` : ""}`;
}

function formatRosterTime(value) {
  const parsed = parseRosterTime(value);
  return parsed ? parsed.normalized : cleanText(value, 40);
}

function extractedTime(text, kind, zone) {
  const source = cleanText(text, 2000);
  // [버그 수정] 정규식의 '?'를 제거하여 Z(Zulu) 또는 L(Local) 구분을 필수적으로 매칭하도록 강제함
  // 이로 인해 STDL을 찾을 때 실수로 STDZ의 시간을 덮어씌우는 현상이 해결됩니다.
  const pattern = new RegExp(`${kind}\\\\s*(?:\\\\(${zone}\\\\)|${zone})[^0-9+-]{0,12}(\\\\d{1,2}:?\\\\d{2}(?:[+-]\\\\d+)?)`, "i");
  const match = source.match(pattern);
  return match ? compactTimeWithOffset(match[1]) : "";
}

function comparePerDiemTimes(left, right) {
  const a = compactTimeWithOffset(left).match(/^(\d{2})(\d{2})/);
  const b = compactTimeWithOffset(right).match(/^(\d{2})(\d{2})/);
  if (!a || !b) return null;
  return (Number(a[1]) * 60 + Number(a[2])) - (Number(b[1]) * 60 + Number(b[2]));
}

function arrivalWithOffset(std, sta) {
  const arrival = compactTimeWithOffset(sta);
  if (!arrival || /[+-]\d+$/.test(arrival)) return arrival;
  const comparison = comparePerDiemTimes(arrival, std);
  return comparison !== null && comparison <= 0 ? `${arrival}+1` : arrival;
}

function rosterDateTimeValue(docData, kind, zone = "Z") {
  // Date는 운항 기준일이며, 각 시간 필드의 +1/-1을 실제 하루 후/전으로 적용합니다.
  // 예: Date=2026.07.24, STAZ=02:30+1 -> 2026-07-25T02:30:00.000Z
  const dateMatch = cleanText(docData.Date, 20).match(/^(\d{4})[.-](\d{2})[.-](\d{2})$/);
  if (!dateMatch) return "";

  const isStd = kind === "STD";
  const primaryField = zone === "L"
    ? (isStd ? (docData.STDL || docData["STD(L)"]) : (docData.STAL || docData["STA(L)"]))
    : (isStd ? (docData.STDZ || docData["STD(Z)"]) : (docData.STAZ || docData["STA(Z)"]));
  const parsedTime = parseRosterTime(primaryField);

  if (parsedTime) {
    const base = Date.UTC(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
      parsedTime.hour,
      parsedTime.minute,
      0,
      0,
    );
    return new Date(base + parsedTime.dayOffset * 86400000).toISOString();
  }

  // 시간 필드가 없을 때만 ICS 원본 ISO 값을 보조값으로 사용합니다.
  const directValue = isStd ? docData.STD : docData.STA;
  return directValue && Number.isFinite(Date.parse(directValue)) ? directValue : "";
}

function applyPerDiemMarkers(docs) {
  const sorted = [...docs].sort((a, b) => {
    const aTime = Date.parse(a.STD || "");
    const bTime = Date.parse(b.STD || "");
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
      return aTime - bTime;
    }

    const aFallback = `${cleanText(a.Date, 20)} ${cleanText(a.STDZ || a.STDL, 20)}`;
    const bFallback = `${cleanText(b.Date, 20)} ${cleanText(b.STDZ || b.STDL, 20)}`;
    return aFallback.localeCompare(bFallback);
  });

  for (let i = 0; i < sorted.length; i += 1) {
    const docData = sorted[i];
    const from = cleanText(docData.From, 10).toUpperCase();
    const to = cleanText(docData.To, 10).toUpperCase();

    let ri = "";
    let ro = "";
    let quickTurn = false;

    // ===== 출발편: ICN → 해외 =====
    if (from === "ICN" && to && to !== "ICN") {
      ri = rosterDateTimeValue(docData, "STA");
    }
    // ===== 귀국편: 해외 → ICN =====
    else if (to === "ICN" && from && from !== "ICN") {
      // 귀국편의 RO는 도착시각이 아니라 현재 편의 출발시각입니다.
      ro = rosterDateTimeValue(docData, "STD");

      // 기존 flightRows[i - 1] 로직과 동일하게 바로 앞 편만 확인합니다.
      if (i > 0) {
        const previous = sorted[i - 1];
        const previousFrom = cleanText(previous.From, 10).toUpperCase();
        const previousTo = cleanText(previous.To, 10).toUpperCase();

        if (previousFrom === "ICN" && previousTo === from) {
          const previousArrival = rosterDateTimeValue(previous, "STA");
          if (previousArrival) {
            ri = previousArrival;
            quickTurn = true;
          }
        }
      }
    }
    // ===== 해외 → 해외 =====
    else if (from && to && from !== "ICN" && to !== "ICN") {
      ri = rosterDateTimeValue(docData, "STA");
      ro = rosterDateTimeValue(docData, "STD");
    }

    docData.RI = ri;
    docData.RO = ro;
    docData.QuickTurn = quickTurn;
  }

  return sorted;
}


const PERDIEM_RATES = {
  LAX: 3.42,
  SFO: 3.42,
  EWR: 3.44,
  HNL: 3.01,
  FRA: 3.18,
  BCN: 3.11,
  BKK: 2.14,
  DAD: 2.01,
  OSL: 3.24,
  DAC: 33,
  NRT: 33,
  HKG: 33,
};

const QUICK_TURN_DESTINATIONS = new Set(["DAC", "NRT", "HKG"]);

function perDiemEventDocId(docData) {
  return hashText([
    docData.owner,
    docData.Date,
    docData.Activity,
    docData.From,
    docData.Destination,
  ].join("|"));
}

function hoursBetweenIso(startIso, endIso) {
  const start = Date.parse(startIso || "");
  const end = Date.parse(endIso || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return (end - start) / 3600000;
}

function formatHoursAsHHmm(hours) {
  const totalMinutes = Math.max(0, Math.round(Number(hours || 0) * 60));
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function buildPerDiemDoc(rosterDoc, owner) {
  const from = cleanText(rosterDoc.From, 10).toUpperCase();
  const to = cleanText(rosterDoc.To, 10).toUpperCase();

  if (!from || !to || from === to) return null;

  const isOutbound = from === "ICN" && to !== "ICN";
  const isInbound = to === "ICN" && from !== "ICN";
  const quickTurn = isInbound && QUICK_TURN_DESTINATIONS.has(from);

  let rateAirport = "";
  let rate = 0;
  let stayHoursNumber = 0;
  let total = 0;
  let transportFee = 0;

  if (isOutbound) {
    rateAirport = to;
    rate = Number(PERDIEM_RATES[to] || 0);
    transportFee = 7000;
  } else if (isInbound) {
    rateAirport = from;
    rate = Number(PERDIEM_RATES[from] || 0);

    if (quickTurn) {
      rate = 33;
      total = 33;
      transportFee = 14000;
    } else {
      stayHoursNumber = hoursBetweenIso(rosterDoc.RI, rosterDoc.RO);
      total = Math.round(rate * stayHoursNumber * 100) / 100;
    }
  } else {
    rateAirport = to;
    rate = Number(PERDIEM_RATES[to] || 0);
    stayHoursNumber = hoursBetweenIso(rosterDoc.RI, rosterDoc.RO);
    total = Math.round(rate * stayHoursNumber * 100) / 100;
  }

  return {
    owner: owner.uid,
    uid: owner.uid,
    Date: rosterDoc.Date || "",
    Activity: rosterDoc.Activity || rosterDoc.F || "",
    From: from,
    Destination: to,
    To: to,
    RI: rosterDoc.RI || "",
    RO: rosterDoc.RO || "",
    StayHours: formatHoursAsHHmm(stayHoursNumber),
    StayHoursNumber: stayHoursNumber,
    RateAirport: rateAirport,
    Rate: rate,
    Total: total,
    TransportFee: transportFee,
    Month: rosterDoc.Month || "",
    Year: rosterDoc.Year || "",
    QuickTurn: Boolean(quickTurn || rosterDoc.QuickTurn),
    email: owner.email || "",
    pdc_user_name: owner.displayName || "",
    display_name: owner.displayName || "",
    source: "pdc_roster",
    sourcePdcEventId: pdcEventDocId(rosterDoc),
    importedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

async function uploadPerDiemDocs(db, owner, rosterDocs) {
  const ownerUid = cleanText(owner.uid, 500);
  if (!ownerUid) throw new Error("FIREBASE_UID is required for PerDiem storage");

  const ownerRef = db.collection(PERDIEM_COLLECTION).doc(ownerPdcDocId(ownerUid));
  const eventsRef = ownerRef.collection("events");

  await ownerRef.set({
    owner: ownerUid,
    uid: ownerUid,
    display_name: owner.displayName || "",
    pdc_user_name: owner.displayName || "",
    email: owner.email || "",
    source: "pdc_roster",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  const perDiemDocs = rosterDocs
    .map((docData) => buildPerDiemDoc(docData, owner))
    .filter(Boolean);

  let saved = 0;
  let deletedDuplicates = 0;

  for (const docData of perDiemDocs) {
    const eventId = perDiemEventDocId(docData);
    const duplicateSnapshot = await eventsRef
      .where("Date", "==", docData.Date)
      .where("Activity", "==", docData.Activity)
      .where("From", "==", docData.From)
      .where("Destination", "==", docData.Destination)
      .get();

    const batch = db.batch();

    for (const duplicateDoc of duplicateSnapshot.docs) {
      if (duplicateDoc.id !== eventId) {
        batch.delete(duplicateDoc.ref);
        deletedDuplicates += 1;
      }
    }

    batch.set(eventsRef.doc(eventId), docData, { merge: true });
    await batch.commit();
    saved += 1;
  }

  return {
    generated: perDiemDocs.length,
    saved,
    deletedDuplicates,
  };
}

function firstRoute(text) {
  const normalized = cleanText(text, 1000).toUpperCase();
  const match = normalized.match(/\b([A-Z]{3})\s*(?:-|–|—|→|>|TO)\s*([A-Z]{3})\b/);
  return {
    from: match?.[1] || "",
    to: match?.[2] || "",
  };
}

function activityFromIcs(summary, description) {
  const text = `${summary} ${description}`;
  const flight = text.match(/\b[A-Z]{2}\s?\d{2,4}[A-Z]?\b/);
  return cleanText((flight?.[0] || summary || "ROSTER").replace(/\s+/g, ""), 80);
}

function crewFromIcsDescription(description) {
  const lines = String(description || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const crewLines = lines
    .filter((line) => /,/u.test(line))
    .filter((line) => /\p{Script=Hangul}/u.test(line));
  const crew = cleanText(crewLines.join("\n"), 1000);
  const crewArray = [];
  for (const line of crewLines) {
    const match = line.match(/([\p{Script=Hangul}]{2,4})\s*,/u);
    if (match && !crewArray.includes(match[1])) crewArray.push(match[1]);
  }
  return { crew, crewArray };
}

function monthName(month) {
  return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1] || "";
}

// HH:mm 형식은 유지하되 +1/-1 날짜 오프셋을 절대 제거하지 않습니다.
function formatToHHmm(value) {
  return formatRosterTime(value);
}

function icsEventToPdcDoc(event, owner) {
  const summary = cleanText(event.SUMMARY?.value || "", 200);
  const description = cleanText(event.DESCRIPTION?.value || "", 1000);
  const location = cleanText(event.LOCATION?.value || "", 200);
  const text = `${summary}\n${description}\n${location}`;
  const start = parseIcsDate(event.DTSTART?.value || "");
  const end = parseIcsDate(event.DTEND?.value || "");
  const endTime = timeWithDateOffset(start, end);
  const route = firstRoute(text);
  const activity = activityFromIcs(summary, description);
  if (!start.date || !activity) return null;
  const stdl = extractedTime(text, "STD", "L") || start.time;
  const stal = extractedTime(text, "STA", "L") || endTime;
  const startCompact = extractedTime(text, "STD", "Z") || compactTimeWithOffset(start.time);
  const endCompact = arrivalWithOffset(startCompact, extractedTime(text, "STA", "Z") || endTime);

  const uid = cleanText(event.UID?.value || hashText(`${summary}_${description}_${start.date}_${start.time}`), 200);
  const year = start.date.slice(0, 4);
  const month = Number.parseInt(start.date.slice(5, 7), 10);
  const { crew, crewArray } = crewFromIcsDescription(description);

  return {
    owner: owner.uid,
    uid: owner.uid,
    Date: start.date,
    DateRaw: start.date,
    Activity: activity,
    From: route.from,
    To: route.to,
    STD: start.iso || "",
    STA: end.iso || "",
    // 최종적으로 formatToHHmm 을 거쳐서 roster 방식("HH:mm")으로만 저장되도록 반영
    STDL: formatToHHmm(stdl),
    STAL: formatToHHmm(stal),
    STDZ: formatToHHmm(startCompact),
    STAZ: formatToHHmm(endCompact),
    "STD(L)": formatToHHmm(stdl),
    "STA(L)": formatToHHmm(stal),
    "STD(Z)": formatToHHmm(startCompact),
    "STA(Z)": formatToHHmm(endCompact),
    // 전체 이벤트를 시간순으로 정렬한 뒤 applyPerDiemMarkers()에서 계산합니다.
    RI: "",
    RO: "",
    QuickTurn: false,
    CIL: "",
    COL: "",
    DC: "",
    F: activity,
    Crew: crew,
    CrewArray: crewArray,
    ET: "00:00",
    NT: "00:00",
    BLH: "",
    Year: year,
    Month: monthName(month),
    pdc_user_name: owner.displayName || "",
    display_name: owner.displayName || "",
    email: owner.email || "",
    source: SLACK_ICAL_SOURCE,
    sourceUidHash: hashText(uid),
    sourceSummary: summary,
    sourceDescription: description,
    sourceLocation: location,
    importedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function pdcDocToRosterRow(doc) {
  return [
    cleanText(doc.DateRaw || doc.Date, 20),
    rosterCsvOwnerLabel(doc),
    cleanText(doc.CIL || doc["C/I(L)"], 20),
    cleanText(doc.COL || doc["C/O(L)"], 20),
    cleanText(doc.Activity, 80),
    cleanText(doc.F || doc.Activity, 80),
    cleanText(doc.From, 10),
    cleanText(doc.STDL || doc["STD(L)"], 40),
    cleanText(doc.STDZ || doc["STD(Z)"], 40),
    cleanText(doc.To || doc.Destination, 10),
    cleanText(doc.STAL || doc["STA(L)"], 40),
    cleanText(doc.STAZ || doc["STA(Z)"], 40),
    cleanText(doc.BLH, 40),
    cleanText(doc.AcReg || doc.ACReg || doc.REG || doc.Reg, 40),
    cleanText(doc.Crew, 1000),
  ];
}

function rosterCsvOwnerLabel(value) {
  const email = cleanText(value.email || value.ownerEmail, 120).toLowerCase();
  const mappedDisplayName = displayNameForEmail(email);
  if (mappedDisplayName) return mappedDisplayName;
  const displayName = cleanText(value.display_name || value.pdc_user_name || value.ownerDisplayName || value.crewName, 80);
  if (displayName) return displayName;
  if (email) return email.includes("@") ? cleanText(email.split("@")[0], 80) : email;
  return cleanText(value.owner || value.uid || value.ownerUid, 80);
}

function pdcDocToCsvRowDoc(doc, eventId = "") {
  const row = pdcDocToRosterRow(doc);
  const data = Object.fromEntries(ROSTER_HEADERS.map((header, index) => [header, row[index] || ""]));
  return {
    ...data,
    owner: cleanText(doc.owner || doc.uid, 500),
    uid: cleanText(doc.uid || doc.owner, 500),
    eventId,
    sortKey: dateSortKey(row[0]),
    source: SLACK_ICAL_SOURCE,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function writeImportedRosterJson(docs, ownerUid) {
  const rows = docs
    .filter((doc) => cleanText(doc.Activity, 80) && cleanText(doc.From, 10) && cleanText(doc.To || doc.Destination, 10))
    .sort((a, b) => {
      const left = `${cleanText(a.DateRaw || a.Date, 20)}_${cleanText(a.STDZ || a.STDL, 40)}_${cleanText(a.Activity, 80)}`;
      const right = `${cleanText(b.DateRaw || b.Date, 20)}_${cleanText(b.STDZ || b.STDL, 40)}_${cleanText(b.Activity, 80)}`;
      return left.localeCompare(right);
    })
    .map(pdcDocToRosterRow);
  const safeOwner = cleanText(ownerUid, 500).replace(/[^A-Za-z0-9_-]/g, "_") || "owner";
  const filePath = path.join(os.tmpdir(), `imported-ical-roster-${safeOwner}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ values: [ROSTER_HEADERS, ...rows] }, null, 2), "utf-8");
  return { filePath, rowCount: rows.length };
}

async function rewriteImportedPerDiem(db, docs, owner) {
  const { filePath, rowCount } = writeImportedRosterJson(docs, owner.uid);
  if (!rowCount) return { deleted: 0, written: 0, skippedDuplicates: 0, rowCount };
  const result = await generateAndRewriteSlackPerDiem(db, filePath, {
    owner: owner.uid,
    uid: owner.uid,
    userId: owner.uid,
    email: owner.email || "",
    displayName: owner.displayName || "",
  });
  return { ...result, rowCount };
}

async function fetchIcsCalendar(calendarUrl) {
  const url = fetchableCalendarUrl(calendarUrl);
  if (!url) throw new Error("webcal:// or https:// iCal URL is required");
  const response = await fetch(url, {
    headers: {
      Accept: "text/calendar, text/plain, */*",
      "User-Agent": "roster-sj-github-actions/1.0",
    },
  });
  if (!response.ok) throw new Error(`iCal fetch failed (${response.status})`);
  const text = await response.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("Response is not an iCal calendar");
  return text;
}

async function uploadPdcDocs(db, owner, docs) {
  const ownerUid = cleanText(owner.uid, 500);
  if (!ownerUid) throw new Error("FIREBASE_UID is required for user-specific rewrite");

  const uniqueDocs = applyPerDiemMarkers(dedupeImportDocs(docs));

  const ownerRef = db.collection(PDC_COLLECTION).doc(ownerPdcDocId(ownerUid));
  const docEntries = uniqueDocs.map((docData) => ({
    id: pdcEventDocId(docData),
    data: docData,
  }));
  const sourceHash = sourceHashForDocEntries(docEntries);
  const ownerSnapshot = await ownerRef.get();
  if (ownerSnapshot.exists && ownerSnapshot.get("sourceHash") === sourceHash) {
    return {
      deleted: 0,
      imported: docEntries.length,
      skippedDuplicates: docs.length - uniqueDocs.length,
      skippedRewrite: true,
    };
  }

  // 사용자별 rewrite: 해당 owner의 기존 Per Diem/PDC 자료만 먼저 삭제합니다.
  const deleted = await deleteExistingOwnerPdcDocs(db, ownerUid);

  const operations = [];
  operations.push((batch) => batch.set(ownerRef, {
    owner: ownerUid,
    uid: ownerUid,
    display_name: owner.displayName || "",
    pdc_user_name: owner.displayName || "",
    email: owner.email || "",
    source: SLACK_ICAL_SOURCE,
    sourceHash,
    sourceHashUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    rewrittenAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true }));

  for (const { id: eventId, data: docData } of docEntries) {
    const eventRef = ownerRef.collection("events").doc(eventId);
    const csvRowRef = ownerRef.collection("csvRows").doc(eventId);
    const mirrorRef = db.collection(PDC_FLAT_MIRROR_COLLECTION).doc(eventId);
    // owner별 하위 컬렉션을 원본으로 유지하고, FlutterFlow용 최상위 mirror도 같이 저장합니다.
    operations.push((batch) => batch.set(eventRef, docData, { merge: false }));
    operations.push((batch) => batch.set(csvRowRef, pdcDocToCsvRowDoc(docData, eventId), { merge: false }));
    operations.push((batch) => batch.set(mirrorRef, docData, { merge: false }));
  }

  await commitInChunks(db, operations);
  return {
    deleted,
    imported: uniqueDocs.length,
    skippedDuplicates: docs.length - uniqueDocs.length,
  };
}


async function resolveOrCreateFirebaseOwner(auth, requestedOwner) {
  const requestedUid = cleanText(requestedOwner.uid, 500);
  const email = cleanText(requestedOwner.email, 240).toLowerCase();
  const requestedDisplayName = cleanText(requestedOwner.displayName, 200);

  if (!email) {
    throw new Error(
      "USER_ID or USER_EMAIL is required because Firebase Auth users are resolved or created by email"
    );
  }

  let userRecord = null;

  // 1) 실제 UID가 전달된 경우 먼저 UID로 확인합니다.
  if (
    requestedUid &&
    !requestedUid.includes("@") &&
    !requestedUid.startsWith("guest_email_")
  ) {
    try {
      userRecord = await auth.getUser(requestedUid);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw new Error(
          `Firebase Authentication UID lookup failed: ${requestedUid} (${error.code || error.message})`
        );
      }
    }

    if (userRecord) {
      const authEmail = cleanText(userRecord.email, 240).toLowerCase();

      if (authEmail && authEmail !== email) {
        throw new Error(
          `Firebase UID/email mismatch: ${requestedUid} belongs to ${authEmail}, not ${email}`
        );
      }

      const updatePayload = {};
      if (!authEmail) updatePayload.email = email;
      if (requestedDisplayName && requestedDisplayName !== userRecord.displayName) {
        updatePayload.displayName = requestedDisplayName;
      }

      if (Object.keys(updatePayload).length) {
        userRecord = await auth.updateUser(userRecord.uid, updatePayload);
      }

      return {
        uid: userRecord.uid,
        email: cleanText(userRecord.email || email, 240).toLowerCase(),
        displayName:
          cleanText(userRecord.displayName, 200) ||
          requestedDisplayName ||
          displayNameForEmail(email),
        created: false,
        resolvedBy: "uid",
      };
    }
  }

  // 2) UID가 없거나 찾지 못한 경우 이메일로 기존 사용자를 조회합니다.
  try {
    userRecord = await auth.getUserByEmail(email);
  } catch (error) {
    if (error.code !== "auth/user-not-found") {
      throw new Error(
        `Firebase Authentication email lookup failed: ${email} (${error.code || error.message})`
      );
    }
  }

  if (userRecord) {
    if (requestedDisplayName && requestedDisplayName !== userRecord.displayName) {
      userRecord = await auth.updateUser(userRecord.uid, {
        displayName: requestedDisplayName,
      });
    }

    return {
      uid: userRecord.uid,
      email: cleanText(userRecord.email || email, 240).toLowerCase(),
      displayName:
        cleanText(userRecord.displayName, 200) ||
        requestedDisplayName ||
        displayNameForEmail(email),
      created: false,
      resolvedBy: "email",
    };
  }

  // 3) Firebase Auth 사용자가 없으면 자동 생성합니다.
  userRecord = await auth.createUser({
    email,
    emailVerified: false,
    disabled: false,
    ...(requestedDisplayName ? { displayName: requestedDisplayName } : {}),
  });

  return {
    uid: userRecord.uid,
    email: cleanText(userRecord.email || email, 240).toLowerCase(),
    displayName:
      cleanText(userRecord.displayName, 200) ||
      requestedDisplayName ||
      displayNameForEmail(email),
    created: true,
    resolvedBy: "created",
  };
}

async function main() {
  const calendarUrl = optionalEnv("INPUT_ICAL_ROSTER_URL") || optionalEnv("ICAL_ROSTER_URL") || optionalEnv("WEB_ROSTER_URL");
  if (!calendarUrl) throw new Error("INPUT_ICAL_ROSTER_URL or ICAL_ROSTER_URL is required");

  const requestedOwner = {
    uid: optionalEnv("FIREBASE_UID"),
    email: optionalEnv("USER_ID") || optionalEnv("USER_EMAIL"),
    displayName:
      optionalEnv("PDC_USER_NAME") ||
      optionalEnv("USER_NAME"),
  };

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(parseJsonEnv("FIREBASE_SERVICE_ACCOUNT")),
    });
  }

  const db = admin.firestore();
  let owner = await resolveOrCreateFirebaseOwner(
    admin.auth(),
    requestedOwner,
  );
  owner = await enrichOwnerFromUsersDoc(db, owner);

  console.log(`OWNER_MODE=FIREBASE_AUTH_AUTO_CREATE`);
  console.log(`OWNER_RESOLUTION=${owner.resolvedBy}`);
  console.log(`FIREBASE_USER_CREATED=${owner.created}`);
  console.log(`RESOLVED_FIREBASE_UID=${owner.uid}`);
  console.log(`RESOLVED_USER_EMAIL=${owner.email}`);
  console.log(`RESOLVED_DISPLAY_NAME=${owner.displayName}`);

  const ics = await fetchIcsCalendar(calendarUrl);
  const events = parseIcsEvents(ics);
  console.log(`Fetched ${events.length} iCal event(s).`);
  const docs = events
    .map((event) => icsEventToPdcDoc(event, owner))
    .filter(Boolean);
  if (!docs.length) throw new Error("iCal calendar was fetched, but no roster events were found");

  const finalRosterDocs = applyPerDiemMarkers(dedupeImportDocs(docs));

  // 1) 원본 Roster는 기존대로 pdc/{uid}/events에 저장합니다.
  const pdcResult = await uploadPdcDocs(db, owner, finalRosterDocs);
  console.log(`PDC_STORAGE_PATH=${PDC_COLLECTION}/${owner.uid}/events`);
  console.log(`PDC_IMPORTED=${pdcResult.imported}`);
  console.log(`PDC_REMOVED_PREVIOUS=${pdcResult.deleted}`);
  console.log(`PDC_SKIPPED_DUPLICATES=${pdcResult.skippedDuplicates}`);
  console.log(`PDC_SKIPPED_REWRITE=${pdcResult.skippedRewrite ? "true" : "false"}`);

  // 2) 같은 Roster를 Perdiem/{uid}/events에 owner 단위로 rewrite합니다.
  const perDiemResult = await rewriteImportedPerDiem(db, finalRosterDocs, owner);
  console.log(`PERDIEM_STORAGE_PATH=${PERDIEM_COLLECTION}/${owner.uid}/events`);
  console.log(`Rewrote Perdiem for this owner; source rows ${perDiemResult.rowCount}; saved ${perDiemResult.written} event(s); removed ${perDiemResult.deleted} previous event(s); skipped ${perDiemResult.skippedDuplicates} duplicate event(s).`);
}

main().catch((error) => {
  console.error(`Import failed: ${error.message}`);
  process.exit(1);
});

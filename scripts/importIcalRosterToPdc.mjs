import crypto from "crypto";
import admin from "firebase-admin";

const PDC_COLLECTION = "pdc";
const SLACK_ICAL_SOURCE = "slack_ical";

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
    "cutecsj773@gmail.com": "최상준",
  };
  return displayNames[normalizedEmail] || "";
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function ownerPdcDocId(ownerUid) {
  return cleanText(ownerUid, 500).replace(/\//g, "_") || "unknown_owner";
}

function pdcMonthKey(docData) {
  return `${cleanText(docData.Year, 10)}_${cleanText(docData.Month, 10)}`;
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
  return [
    docData.owner,
    docData.Date,
    docData.Activity,
    docData.From,
    docData.To,
    crewKey(docData),
  ].join("|");
}

function preferredDuplicateDoc(current, candidate) {
  if (!current) return candidate;
  const currentTime = cleanText(current.STDL || current["STD(L)"] || current.STDZ || current.STD, 40);
  const candidateTime = cleanText(candidate.STDL || candidate["STD(L)"] || candidate.STDZ || candidate.STD, 40);
  return candidateTime >= currentTime ? candidate : current;
}

function dedupeImportDocs(docs) {
  const byKey = new Map();
  for (const docData of docs) {
    const key = importDuplicateKey(docData);
    byKey.set(key, preferredDuplicateDoc(byKey.get(key), docData));
  }
  return [...byKey.values()];
}

async function deleteExistingImportMonthDocs(db, docs) {
  const owner = cleanText(docs[0]?.owner, 500);
  if (!owner) return 0;

  const monthKeys = new Set(docs.map(pdcMonthKey).filter((key) => !key.includes("__")));
  const shouldDelete = (data) =>
    data?.source === SLACK_ICAL_SOURCE &&
    data?.owner === owner &&
    monthKeys.has(pdcMonthKey(data));

  const refs = new Map();
  const flatSnapshot = await db.collection(PDC_COLLECTION).where("owner", "==", owner).get();
  for (const doc of flatSnapshot.docs) {
    if (shouldDelete(doc.data())) refs.set(doc.ref.path, doc.ref);
  }

  const eventsSnapshot = await db
    .collection(PDC_COLLECTION)
    .doc(ownerPdcDocId(owner))
    .collection("events")
    .get();
  for (const doc of eventsSnapshot.docs) {
    if (shouldDelete(doc.data())) refs.set(doc.ref.path, doc.ref);
  }

  for (const ref of refs.values()) {
    await ref.delete();
  }
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
  const match = cleanText(value, 40).match(/^(\d{1,2}):(\d{2})([+-]\d+)?$/);
  if (!match) return cleanText(value, 40);
  return `${match[1].padStart(2, "0")}${match[2]}${match[3] || ""}`;
}

function extractedTime(text, kind, zone) {
  const source = cleanText(text, 2000);
  const pattern = new RegExp(`${kind}\\\\s*(?:\\\\(${zone}\\\\)|${zone})?[^0-9+-]{0,12}(\\\\d{1,2}:?\\\\d{2}(?:[+-]\\\\d+)?)`, "i");
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

function perDiemMarkers(route, end) {
  const from = cleanText(route.from, 10).toUpperCase();
  const to = cleanText(route.to, 10).toUpperCase();
  const arrivalIso = end.iso || "";
  return {
    RI: from === "ICN" && to && to !== "ICN" ? arrivalIso : "",
    RO: to === "ICN" && from && from !== "ICN" ? arrivalIso : "",
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
  const markers = perDiemMarkers(route, end);

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
    STDL: stdl,
    STAL: stal,
    STDZ: startCompact,
    STAZ: endCompact,
    "STD(L)": stdl,
    "STA(L)": stal,
    "STD(Z)": startCompact,
    "STA(Z)": endCompact,
    RI: markers.RI,
    RO: markers.RO,
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

async function uploadPdcDocs(db, docs) {
  const uniqueDocs = dedupeImportDocs(docs);
  let deleted = await deleteExistingImportMonthDocs(db, uniqueDocs);
  let imported = 0;

  for (const docData of uniqueDocs) {
    const batch = db.batch();
    const ownerRef = db.collection(PDC_COLLECTION).doc(ownerPdcDocId(docData.owner));
    const eventRef = ownerRef.collection("events").doc(pdcEventDocId(docData));
    batch.set(ownerRef, {
      owner: docData.owner,
      uid: docData.uid,
      display_name: docData.display_name || docData.pdc_user_name || "",
      pdc_user_name: docData.pdc_user_name || "",
      email: docData.email || "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(eventRef, docData, { merge: true });
    batch.set(db.collection(PDC_COLLECTION).doc(), docData);
    await batch.commit();
    imported += 1;
  }

  return { deleted, imported, skippedDuplicates: docs.length - uniqueDocs.length };
}

async function main() {
  const calendarUrl = optionalEnv("INPUT_ICAL_ROSTER_URL") || optionalEnv("ICAL_ROSTER_URL") || optionalEnv("WEB_ROSTER_URL");
  if (!calendarUrl) throw new Error("INPUT_ICAL_ROSTER_URL or ICAL_ROSTER_URL is required");

  const owner = {
    uid: requiredEnv("FIREBASE_UID"),
    email: optionalEnv("USER_ID") || optionalEnv("USER_EMAIL"),
  };
  owner.displayName = optionalEnv("PDC_USER_NAME") || optionalEnv("USER_NAME") || displayNameForEmail(owner.email);

  admin.initializeApp({
    credential: admin.credential.cert(parseJsonEnv("FIREBASE_SERVICE_ACCOUNT")),
  });
  const db = admin.firestore();

  const ics = await fetchIcsCalendar(calendarUrl);
  const events = parseIcsEvents(ics);
  console.log(`Fetched ${events.length} iCal event(s).`);
  const docs = events
    .map((event) => icsEventToPdcDoc(event, owner))
    .filter(Boolean);
  if (!docs.length) throw new Error("iCal calendar was fetched, but no roster events were found");

  const result = await uploadPdcDocs(db, docs);
  console.log(`Saved ${result.imported} event(s) to ${PDC_COLLECTION}; removed ${result.deleted} old event(s); skipped ${result.skippedDuplicates} duplicate event(s).`);
}

main().catch((error) => {
  console.error(`Import failed: ${error.message}`);
  process.exit(1);
});

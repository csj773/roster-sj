import { cleanText, db, json, setCors } from "./_lib/shareUtils.mjs";

const ROSTER_COLLECTION = "roster";
const PDC_COLLECTION = "pdc";
const PDC_FLAT_MIRROR_COLLECTION = "PdcEvents";

function ownerPdcDocId(ownerUid) {
  return cleanText(ownerUid, 500).replace(/\//g, "_") || "unknown_owner";
}

function upper(value) {
  return cleanText(value, 20).toUpperCase();
}

function eventSummary(doc, data) {
  const crewArray = Array.isArray(data.CrewArray)
    ? data.CrewArray.map((name) => cleanText(name, 80)).filter(Boolean)
    : Array.isArray(data.crewArray)
      ? data.crewArray.map((name) => cleanText(name, 80)).filter(Boolean)
      : cleanText(data.Crew, 1000).split(",").map((name) => cleanText(name, 80)).filter(Boolean);

  return {
    id: doc.id,
    owner: cleanText(data.owner || data.uid, 500),
    date: cleanText(data.Date, 20),
    activity: cleanText(data.Activity, 80),
    from: upper(data.From),
    to: upper(data.To),
    stdl: cleanText(data.STDL || data["STD(L)"], 40),
    stal: cleanText(data.STAL || data["STA(L)"], 40),
    crew: cleanText(data.Crew, 1000),
    crewArray,
    sourcePath: doc.ref.path,
  };
}

async function findRosterEvent(owner, eventId) {
  const rosterDoc = await db().collection(ROSTER_COLLECTION).doc(eventId).get();
  if (rosterDoc.exists) {
    const data = rosterDoc.data();
    if (cleanText(data.owner || data.uid, 500) === owner) return eventSummary(rosterDoc, data);
  }

  const pdcDoc = await db()
    .collection(PDC_COLLECTION)
    .doc(ownerPdcDocId(owner))
    .collection("events")
    .doc(eventId)
    .get();
  if (pdcDoc.exists) {
    const data = pdcDoc.data();
    if (cleanText(data.owner || data.uid, 500) === owner) return eventSummary(pdcDoc, data);
  }

  const mirrorDoc = await db().collection(PDC_FLAT_MIRROR_COLLECTION).doc(eventId).get();
  if (mirrorDoc.exists) {
    const data = mirrorDoc.data();
    if (cleanText(data.owner || data.uid, 500) === owner) return eventSummary(mirrorDoc, data);
  }

  return null;
}

function requestQuery(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  const host = req.headers.host || "localhost";
  const url = new URL(req.url || "/", `https://${host}`);
  return Object.fromEntries(url.searchParams.entries());
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const query = requestQuery(req);
    const owner = cleanText(query.owner, 500);
    const eventId = cleanText(query.event, 500);
    if (!owner || !eventId) {
      json(res, 400, { error: "owner and event are required" });
      return;
    }

    const event = await findRosterEvent(owner, eventId);
    if (!event) {
      json(res, 404, { error: "Roster event not found" });
      return;
    }

    json(res, 200, { ok: true, event });
  } catch (error) {
    console.error("Public roster event failed:", error);
    json(res, 500, { error: error.message });
  }
}

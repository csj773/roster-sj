import {
  cleanDate,
  cleanText,
  db,
  json,
  publicUser,
  requireFirebaseUser,
  setCors,
} from "./_shareUtils.mjs";

const SHARE_COLLECTION = "roster_shares";
const ROSTER_COLLECTION = "roster";
const DEFAULT_DAYS = 14;
const MAX_DAYS = 45;

function addDays(ymd, days) {
  const date = new Date(`${ymd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todaySeoul() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function dateInRange(value, startDate, endDate) {
  if (!value) return false;
  return value >= startDate && value <= endDate;
}

function upper(value) {
  return cleanText(value, 20).toUpperCase();
}

function isOffDuty(activity) {
  return /^(REST|OFF|OFFD|DAY OFF|DO|VAC|LEAVE|RSV)$/i.test(cleanText(activity, 40));
}

function rosterSummary(doc, person) {
  const data = doc.data();
  const from = upper(data.From);
  const to = upper(data.To);
  const activity = cleanText(data.Activity, 80);
  return {
    id: doc.id,
    ownerUid: data.owner || person.uid,
    crewName: person.displayName || data.ownerDisplayName || "",
    date: cleanText(data.Date, 20),
    activity,
    dutyCode: cleanText(data.DC, 20),
    from,
    to,
    flightNo: activity,
    cil: cleanText(data.CIL || data["C/I(L)"], 20),
    col: cleanText(data.COL || data["C/O(L)"], 20),
    stdl: cleanText(data.STDL || data["STD(L)"], 20),
    stal: cleanText(data.STAL || data["STA(L)"], 20),
    crew: cleanText(data.Crew, 1000),
    crewArray: Array.isArray(data.CrewArray) ? data.CrewArray : [],
    type: isOffDuty(activity) ? "day_off" : "flight",
  };
}

function stationMatches(item, station) {
  if (!station) return true;
  return item.from === station || item.to === station;
}

async function sharedOwnersFor(uid) {
  const owners = new Map();
  owners.set(uid, { uid, relation: "self", scope: "full", ...(await publicUser(uid)) });

  const shares = await db()
    .collection(SHARE_COLLECTION)
    .where("sharedWithUid", "==", uid)
    .get();

  for (const doc of shares.docs) {
    const share = doc.data();
    if (share.status !== "active" || !share.ownerUid) continue;
    owners.set(share.ownerUid, {
      uid: share.ownerUid,
      relation: "shared",
      scope: share.scope || "layover_only",
      displayName: share.ownerDisplayName || "",
      email: share.ownerEmail || "",
    });
  }

  return [...owners.values()];
}

async function rosterForOwner(owner, { startDate, endDate, station }) {
  const snapshot = await db()
    .collection(ROSTER_COLLECTION)
    .where("owner", "==", owner.uid)
    .get();

  return snapshot.docs
    .map((doc) => rosterSummary(doc, owner))
    .filter((item) => dateInRange(item.date, startDate, endDate))
    .filter((item) => stationMatches(item, station))
    .map((item) => ({
      ...item,
      relation: owner.relation,
      shareScope: owner.scope,
    }));
}

function groupLayovers(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.type !== "flight") continue;
    for (const station of [item.from, item.to].filter(Boolean)) {
      const key = `${item.date}_${station}`;
      const group = groups.get(key) || { date: item.date, station, crew: [] };
      group.crew.push({
        ownerUid: item.ownerUid,
        crewName: item.crewName,
        activity: item.activity,
        from: item.from,
        to: item.to,
        stdl: item.stdl,
        stal: item.stal,
      });
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => `${a.date}_${a.station}`.localeCompare(`${b.date}_${b.station}`));
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
    const user = await requireFirebaseUser(req);
    const query = requestQuery(req);
    const startDate = cleanDate(query.startDate || query.date) || todaySeoul();
    const days = Math.min(Math.max(Number.parseInt(query.days || `${DEFAULT_DAYS}`, 10) || DEFAULT_DAYS, 1), MAX_DAYS);
    const endDate = cleanDate(query.endDate) || addDays(startDate, days - 1);
    const station = upper(query.station || "");
    const mode = cleanText(query.mode || "calendar", 20);

    const owners = await sharedOwnersFor(user.uid);
    const nested = await Promise.all(owners.map((owner) => rosterForOwner(owner, { startDate, endDate, station })));
    const items = nested.flat().sort((a, b) => {
      const left = `${a.date}_${a.cil || a.stdl || ""}_${a.crewName}_${a.activity}`;
      const right = `${b.date}_${b.cil || b.stdl || ""}_${b.crewName}_${b.activity}`;
      return left.localeCompare(right);
    });

    json(res, 200, {
      ok: true,
      startDate,
      endDate,
      station,
      owners: owners.map(({ uid, relation, scope, displayName }) => ({ uid, relation, scope, displayName })),
      items,
      layovers: mode === "layover" || station ? groupLayovers(items) : [],
    });
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message });
  }
}

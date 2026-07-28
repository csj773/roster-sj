import {
  cleanDate,
  cleanText,
  db,
  json,
  publicUser,
  requireFirebaseUser,
  setCors,
} from "./_lib/shareUtils.mjs";

const SHARE_COLLECTION = "roster_shares";
const ROSTER_COLLECTION = "roster";
const PDC_COLLECTION = "pdc";
const SHARE_ROSTER_COLLECTIONS = [ROSTER_COLLECTION, PDC_COLLECTION];
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
  const key = dateSortKey(value);
  return key >= dateSortKey(startDate) && key <= dateSortKey(endDate);
}

function dateSortKey(value) {
  const match = String(value || "").match(
    /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})$/
  );

  if (!match) return cleanText(value, 20);

  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(
    2,
    "0"
  )}`;
}

function upper(value) {
  return cleanText(value, 20).toUpperCase();
}

function isOffDuty(activity) {
  return /^(REST|OFF|OFFD|DAY OFF|DO|VAC|LEAVE|RSV)$/i.test(
    cleanText(activity, 40)
  );
}

function ownerPdcDocId(ownerUid) {
  return cleanText(ownerUid, 500).replace(/\//g, "_") || "unknown_owner";
}

function guestEmailUid(email) {
  return `guest_email_${cleanText(email, 240).toLowerCase()}`
    .replace(/[^A-Za-z0-9_-]/g, "_");
}

function rosterSummary(doc, person) {
  const data = doc.data();
  const from = upper(data.From);
  const to = upper(data.To);
  const activity = cleanText(data.Activity, 80);

  return {
    id: doc.id,
    sourcePath: doc.ref.path,
    ownerUid: cleanText(data.owner || data.uid || person.uid, 500),
    crewName:
      person.displayName ||
      data.display_name ||
      data.pdc_user_name ||
      data.ownerDisplayName ||
      data.email ||
      person.email ||
      "",
    date: cleanText(data.Date, 20),
    activity,
    dutyCode: cleanText(data.DC, 20),
    from,
    to,
    flightNo: activity,
    cil: cleanText(
      data.CIL ||
        data["C/I(L)"] ||
        data.CI,
      40
    ),
    col: cleanText(
      data.COL ||
        data["C/O(L)"] ||
        data.CO,
      40
    ),
    stdl: cleanText(
      data.STDL ||
        data["STD(L)"] ||
        data.STDZ ||
        data["STD(Z)"] ||
        data.STD,
      40
    ),
    stal: cleanText(
      data.STAL ||
        data["STA(L)"] ||
        data.STAZ ||
        data["STA(Z)"] ||
        data.STA,
      40
    ),
    crew: cleanText(data.Crew, 1000),
    crewArray: Array.isArray(data.CrewArray)
      ? data.CrewArray.map((name) => cleanText(name, 80)).filter(Boolean)
      : Array.isArray(data.crewArray)
        ? data.crewArray.map((name) => cleanText(name, 80)).filter(Boolean)
        : [],
    type: isOffDuty(activity) ? "day_off" : "flight",
  };
}

function stationMatches(item, station) {
  if (!station) return true;
  return item.from === station || item.to === station;
}

async function sharedOwnersFor(uid) {
  const owners = new Map();
  const self = await publicUser(uid);

  owners.set(uid, {
    uid,
    relation: "self",
    scope: "full",
    ...self,
  });

  const email = cleanText(self.email || "", 240).toLowerCase();
  const sharedWithCandidates = [
    uid,
    email,
    email ? guestEmailUid(email) : "",
  ].filter(Boolean);

  for (const sharedWithUid of [...new Set(sharedWithCandidates)]) {
    const shares = await db()
      .collection(SHARE_COLLECTION)
      .where("sharedWithUid", "==", sharedWithUid)
      .get();

    for (const doc of shares.docs) {
      const share = doc.data();

      if (share.status !== "active" || !share.ownerUid) continue;

      owners.set(share.ownerUid, {
        uid: share.ownerUid,
        relation: "shared",
        scope: share.scope || "layover_only",
        displayName:
          share.ownerDisplayName ||
          share.ownerEmail ||
          share.ownerUid,
        email: share.ownerEmail || "",
      });
    }
  }

  return [...owners.values()];
}

async function rosterDocsForOwner(ownerUid, collectionName) {
  if (collectionName === PDC_COLLECTION) {
    const nestedSnapshot = await db()
      .collection(PDC_COLLECTION)
      .doc(ownerPdcDocId(ownerUid))
      .collection("events")
      .get();

    return nestedSnapshot.docs;
  }

  const flatByOwner = await db()
    .collection(collectionName)
    .where("owner", "==", ownerUid)
    .get();

  return flatByOwner.docs;
}

async function rosterForOwner(
  owner,
  collectionName,
  { startDate, endDate, station }
) {
  const docs = await rosterDocsForOwner(owner.uid, collectionName);

  console.log("ROSTER_SHARE_OWNER_DOCS", {
    ownerUid: owner.uid,
    ownerName: owner.displayName || owner.email || "",
    collectionName,
    count: docs.length,
  });

  return docs
    .map((doc) => rosterSummary(doc, owner))
    .filter((item) => item.date && item.activity)
    .filter((item) => dateInRange(item.date, startDate, endDate))
    .filter((item) => stationMatches(item, station))
    .map((item) => ({
      ...item,
      sourceCollection: collectionName,
      relation: owner.relation,
      shareScope: owner.scope,
    }));
}

function crewKey(item) {
  if (!Array.isArray(item.crewArray)) return "";

  return item.crewArray
    .map((name) => cleanText(name, 80).toUpperCase())
    .filter(Boolean)
    .sort()
    .join(",");
}

function rosterItemKey(item) {
  return [
    item.ownerUid,
    dateSortKey(item.date),
    item.activity,
    item.from,
    item.to,
    item.stdl,
    item.stal,
    crewKey(item),
  ].join("|");
}

function dedupeRosterItems(items) {
  const unique = new Map();

  for (const item of items) {
    const key = rosterItemKey(item);
    if (!unique.has(key)) unique.set(key, item);
  }

  return [...unique.values()];
}

function groupLayovers(items) {
  const groups = new Map();

  for (const item of items) {
    if (item.type !== "flight") continue;

    for (const station of [item.from, item.to].filter(Boolean)) {
      const key = `${item.date}_${station}`;
      const group = groups.get(key) || {
        date: item.date,
        station,
        crew: [],
      };

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

  return [...groups.values()].sort((a, b) =>
    `${a.date}_${a.station}`.localeCompare(`${b.date}_${b.station}`)
  );
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

    const startDate =
      cleanDate(query.startDate || query.date) || todaySeoul();

    const days = Math.min(
      Math.max(
        Number.parseInt(query.days || `${DEFAULT_DAYS}`, 10) || DEFAULT_DAYS,
        1
      ),
      MAX_DAYS
    );

    const endDate =
      cleanDate(query.endDate) || addDays(startDate, days - 1);

    const station = upper(query.station || "");
    const mode = cleanText(query.mode || "calendar", 20);

    const owners = await sharedOwnersFor(user.uid);

    console.log(
      "ROSTER_SHARE_OWNERS",
      owners.map((owner) => ({
        uid: owner.uid,
        relation: owner.relation,
        scope: owner.scope,
        displayName: owner.displayName,
        email: owner.email,
      }))
    );

    const nested = await Promise.all(
      owners.flatMap((owner) =>
        SHARE_ROSTER_COLLECTIONS.map((collectionName) =>
          rosterForOwner(owner, collectionName, {
            startDate,
            endDate,
            station,
          })
        )
      )
    );

    const items = dedupeRosterItems(nested.flat()).sort((a, b) => {
      const left =
        `${dateSortKey(a.date)}_${a.cil || a.stdl || ""}_` +
        `${a.crewName}_${a.activity}`;

      const right =
        `${dateSortKey(b.date)}_${b.cil || b.stdl || ""}_` +
        `${b.crewName}_${b.activity}`;

      return left.localeCompare(right);
    });

    json(res, 200, {
      ok: true,
      startDate,
      endDate,
      station,
      owners: owners.map(
        ({ uid, relation, scope, displayName, email }) => ({
          uid,
          relation,
          scope,
          displayName,
          email,
        })
      ),
      items,
      layovers:
        mode === "layover" || station ? groupLayovers(items) : [],
    });
  } catch (error) {
    console.error("Roster Share API failed:", error);
    json(res, error.statusCode || 500, {
      error: error.message,
    });
  }
}

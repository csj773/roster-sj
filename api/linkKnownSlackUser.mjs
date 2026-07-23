import { db, json, nowTimestamp, publicUser } from "./_shareUtils.mjs";

const SLACK_LINK_COLLECTION = "slack_user_links";
const LINK_ID = "T0BJJ9E0KGX_U0BJZKZSSR0";
const SLACK_TEAM_ID = "T0BJJ9E0KGX";
const SLACK_USER_ID = "U0BJZKZSSR0";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const firebaseUid = String(process.env.SLACK_DEFAULT_FIREBASE_UID || "").trim();
    if (!firebaseUid) {
      json(res, 500, { error: "SLACK_DEFAULT_FIREBASE_UID is not configured" });
      return;
    }

    const owner = await publicUser(firebaseUid);
    await db().collection(SLACK_LINK_COLLECTION).doc(LINK_ID).set({
      firebaseUid,
      uid: firebaseUid,
      slackTeamId: SLACK_TEAM_ID,
      slackUserId: SLACK_USER_ID,
      slackUserName: "sang joon choi",
      firebaseDisplayName: owner.displayName || "",
      firebaseEmail: owner.email || "",
      status: "active",
      source: "temporary_known_link",
      updatedAt: nowTimestamp(),
      createdAt: nowTimestamp(),
    }, { merge: true });

    json(res, 200, {
      ok: true,
      linkId: LINK_ID,
      firebaseUser: owner.displayName || owner.email || "linked",
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}

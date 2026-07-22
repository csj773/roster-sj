import admin from "firebase-admin";
import {
  cleanText,
  db,
  friendshipId,
  json,
  nowTimestamp,
  publicUser,
  readJsonBody,
  requireFirebaseUser,
  setCors,
  shareId,
} from "./_shareUtils.mjs";

const INVITE_COLLECTION = "roster_share_invites";
const SHARE_COLLECTION = "roster_shares";
const FRIEND_COLLECTION = "roster_friendships";

function writeShare(tx, { owner, sharedWith, scope, inviteCode, acceptedByUid }) {
  const ownerUid = owner.uid;
  const sharedWithUid = sharedWith.uid;
  const ref = db().collection(SHARE_COLLECTION).doc(shareId(ownerUid, sharedWithUid));
  tx.set(ref, {
    ownerUid,
    ownerDisplayName: owner.displayName,
    ownerEmail: owner.email,
    sharedWithUid,
    sharedWithDisplayName: sharedWith.displayName,
    sharedWithEmail: sharedWith.email,
    scope,
    status: "active",
    inviteCode,
    acceptedByUid,
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  }, { merge: true });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const user = await requireFirebaseUser(req);
    const body = await readJsonBody(req);
    const code = cleanText(body.inviteCode || body.code || "", 80);
    const mutual = body.mutual !== false;
    if (!code) {
      json(res, 400, { error: "inviteCode is required" });
      return;
    }

    const inviteRef = db().collection(INVITE_COLLECTION).doc(code);
    const inviteSnap = await inviteRef.get();
    if (!inviteSnap.exists) {
      json(res, 404, { error: "Invite not found" });
      return;
    }

    const invite = inviteSnap.data();
    if (invite.status !== "open") {
      json(res, 409, { error: "Invite is not open" });
      return;
    }
    if (invite.ownerUid === user.uid) {
      json(res, 400, { error: "You cannot accept your own invite" });
      return;
    }
    if (invite.expiresAt?.toDate && invite.expiresAt.toDate().getTime() < Date.now()) {
      json(res, 410, { error: "Invite expired" });
      return;
    }
    if ((invite.useCount || 0) >= (invite.maxUses || 1)) {
      json(res, 409, { error: "Invite has already been used" });
      return;
    }

    const ownerUid = invite.ownerUid;
    const scope = invite.scope || "layover_only";
    const ownerProfile = await publicUser(ownerUid);
    const userProfile = await publicUser(user.uid);
    await db().runTransaction(async (tx) => {
      const freshInvite = await tx.get(inviteRef);
      const fresh = freshInvite.data();
      if (!freshInvite.exists || fresh.status !== "open") throw new Error("Invite is no longer open");
      if ((fresh.useCount || 0) >= (fresh.maxUses || 1)) throw new Error("Invite has already been used");

      writeShare(tx, {
        owner: ownerProfile,
        sharedWith: userProfile,
        scope,
        inviteCode: code,
        acceptedByUid: user.uid,
      });
      if (mutual) {
        writeShare(tx, {
          owner: userProfile,
          sharedWith: ownerProfile,
          scope,
          inviteCode: code,
          acceptedByUid: user.uid,
        });
      }

      const friendshipRef = db().collection(FRIEND_COLLECTION).doc(friendshipId(ownerUid, user.uid));
      tx.set(friendshipRef, {
        users: [ownerUid, user.uid].sort(),
        status: "active",
        scope,
        source: "invite",
        inviteCode: code,
        mutual,
        updatedAt: nowTimestamp(),
        createdAt: nowTimestamp(),
      }, { merge: true });

      tx.update(inviteRef, {
        status: "accepted",
        acceptedByUid: user.uid,
        acceptedAt: nowTimestamp(),
        updatedAt: nowTimestamp(),
        useCount: admin.firestore.FieldValue.increment(1),
      });
    });

    json(res, 200, {
      ok: true,
      ownerUid,
      sharedWithUid: user.uid,
      mutual,
      scope,
    });
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message });
  }
}

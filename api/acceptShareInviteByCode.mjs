import admin from "firebase-admin";
import {
  cleanText,
  db,
  friendshipId,
  json,
  nowTimestamp,
  publicUser,
  readJsonBody,
  setCors,
  shareId,
} from "./_lib/shareUtils.mjs";

const INVITE_COLLECTION = "roster_share_invites";
const SHARE_COLLECTION = "roster_shares";
const FRIEND_COLLECTION = "roster_friendships";

function guestUidForInvite(code) {
  return `guest_${cleanText(code, 80)}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function guestProfile(invite, code) {
  const email = cleanText(invite.recipientEmail || "", 240);
  return {
    uid: guestUidForInvite(code),
    displayName: email || "Roster Share guest",
    email,
  };
}

function writeGuestShare(tx, { owner, sharedWith, scope, inviteCode }) {
  const ref = db().collection(SHARE_COLLECTION).doc(shareId(owner.uid, sharedWith.uid));
  tx.set(ref, {
    ownerUid: owner.uid,
    ownerDisplayName: owner.displayName,
    ownerEmail: owner.email,
    sharedWithUid: sharedWith.uid,
    sharedWithDisplayName: sharedWith.displayName,
    sharedWithEmail: sharedWith.email,
    sharedWithType: "guest_invite_code",
    scope,
    status: "active",
    confirmationStatus: "accepted",
    confirmed: true,
    inviteCode,
    acceptedByUid: sharedWith.uid,
    confirmedByUid: sharedWith.uid,
    confirmedAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  }, { merge: true });
}

function profileFromUid(uid, data = {}) {
  return {
    uid,
    displayName: data.displayName || data.display_name || data.name || data.email || uid,
    email: data.email || "",
  };
}

async function participantProfiles(extraProfiles = []) {
  const profiles = new Map();
  for (const profile of extraProfiles) {
    if (profile?.uid) profiles.set(profile.uid, profile);
  }

  const inviteSnap = await db()
    .collection(INVITE_COLLECTION)
    .where("confirmed", "==", true)
    .limit(100)
    .get();
  for (const doc of inviteSnap.docs) {
    const invite = doc.data();
    if (invite.ownerUid) {
      profiles.set(invite.ownerUid, profileFromUid(invite.ownerUid, {
        displayName: invite.ownerDisplayName,
        email: invite.ownerEmail,
      }));
    }
    if (invite.acceptedByUid) {
      profiles.set(invite.acceptedByUid, profileFromUid(invite.acceptedByUid, {
        displayName: invite.recipientEmail,
        email: invite.recipientEmail,
      }));
    }
  }

  const shareSnap = await db()
    .collection(SHARE_COLLECTION)
    .where("status", "==", "active")
    .limit(200)
    .get();
  for (const doc of shareSnap.docs) {
    const share = doc.data();
    if (share.ownerUid) {
      profiles.set(share.ownerUid, profileFromUid(share.ownerUid, {
        displayName: share.ownerDisplayName,
        email: share.ownerEmail,
      }));
    }
    if (share.sharedWithUid) {
      profiles.set(share.sharedWithUid, profileFromUid(share.sharedWithUid, {
        displayName: share.sharedWithDisplayName,
        email: share.sharedWithEmail,
      }));
    }
  }

  return [...profiles.values()];
}

function shareDocData({ owner, sharedWith, scope, inviteCode, source }) {
  return {
    ownerUid: owner.uid,
    ownerDisplayName: owner.displayName || "",
    ownerEmail: owner.email || "",
    sharedWithUid: sharedWith.uid,
    sharedWithDisplayName: sharedWith.displayName || "",
    sharedWithEmail: sharedWith.email || "",
    scope,
    status: "active",
    confirmationStatus: "accepted",
    confirmed: true,
    inviteCode,
    source,
    acceptedByUid: sharedWith.uid,
    confirmedByUid: sharedWith.uid,
    confirmedAt: nowTimestamp(),
    updatedAt: nowTimestamp(),
    createdAt: nowTimestamp(),
  };
}

async function shareOwnerWithParticipants(owner, participants, { scope, inviteCode, source }) {
  const unique = participants.filter((participant) => participant.uid && participant.uid !== owner.uid);
  for (let i = 0; i < unique.length; i += 200) {
    const batch = db().batch();
    for (const participant of unique.slice(i, i + 200)) {
      batch.set(
        db().collection(SHARE_COLLECTION).doc(shareId(owner.uid, participant.uid)),
        shareDocData({ owner, sharedWith: participant, scope, inviteCode, source }),
        { merge: true }
      );
      batch.set(
        db().collection(SHARE_COLLECTION).doc(shareId(participant.uid, owner.uid)),
        shareDocData({ owner: participant, sharedWith: owner, scope, inviteCode, source }),
        { merge: true }
      );
    }
    await batch.commit();
  }
  return unique.length;
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
    const body = await readJsonBody(req);
    const code = cleanText(body.inviteCode || body.code || body.invite || "", 80);
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
    if (invite.expiresAt?.toDate && invite.expiresAt.toDate().getTime() < Date.now()) {
      json(res, 410, { error: "Invite expired" });
      return;
    }

    const owner = await publicUser(invite.ownerUid);
    const guest = guestProfile(invite, code);
    const scope = cleanText(invite.scope || "layover_only", 40) || "layover_only";

    if (invite.status === "accepted" && invite.acceptedByUid === guest.uid) {
      const sharedWithCount = await shareOwnerWithParticipants(
        guest,
        await participantProfiles([owner, guest]),
        {
          scope,
          inviteCode: code,
          source: "invite_code_auto_channel_share",
        }
      );
      json(res, 200, {
        ok: true,
        alreadyAccepted: true,
        inviteCode: code,
        ownerUid: invite.ownerUid,
        sharedWithUid: guest.uid,
        sharedWithCount,
        confirmationStatus: "accepted",
        confirmed: true,
      });
      return;
    }

    if (invite.status !== "open") {
      json(res, 409, { error: "Invite is not open" });
      return;
    }
    if ((invite.useCount || 0) >= (invite.maxUses || 1)) {
      json(res, 409, { error: "Invite has already been used" });
      return;
    }

    await db().runTransaction(async (tx) => {
      const freshInvite = await tx.get(inviteRef);
      if (!freshInvite.exists) throw new Error("Invite not found");
      const fresh = freshInvite.data();
      if (fresh.expiresAt?.toDate && fresh.expiresAt.toDate().getTime() < Date.now()) {
        throw new Error("Invite expired");
      }
      if (fresh.status !== "open") throw new Error("Invite is no longer open");
      if ((fresh.useCount || 0) >= (fresh.maxUses || 1)) {
        throw new Error("Invite has already been used");
      }

      writeGuestShare(tx, {
        owner,
        sharedWith: guest,
        scope,
        inviteCode: code,
      });

      tx.set(db().collection(FRIEND_COLLECTION).doc(friendshipId(owner.uid, guest.uid)), {
        users: [owner.uid, guest.uid].sort(),
        status: "active",
        scope,
        source: "invite_code",
        inviteCode: code,
        mutual: false,
        confirmationStatus: "accepted",
        confirmed: true,
        confirmedByUid: guest.uid,
        confirmedAt: nowTimestamp(),
        updatedAt: nowTimestamp(),
        createdAt: nowTimestamp(),
      }, { merge: true });

      tx.update(inviteRef, {
        status: "accepted",
        confirmationStatus: "accepted",
        confirmed: true,
        acceptedByUid: guest.uid,
        acceptedByType: "guest_invite_code",
        acceptedAt: nowTimestamp(),
        confirmedByUid: guest.uid,
        confirmedAt: nowTimestamp(),
        updatedAt: nowTimestamp(),
        useCount: admin.firestore.FieldValue.increment(1),
      });
    });

    const sharedWithCount = await shareOwnerWithParticipants(
      guest,
      await participantProfiles([owner, guest]),
      {
        scope,
        inviteCode: code,
        source: "invite_code_auto_channel_share",
      }
    );

    json(res, 200, {
      ok: true,
      inviteCode: code,
      ownerUid: invite.ownerUid,
      sharedWithUid: guest.uid,
      sharedWithCount,
      confirmationStatus: "accepted",
      confirmed: true,
    });
  } catch (error) {
    json(res, error.statusCode || 500, { error: error.message });
  }
}

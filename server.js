const express = require('express');
const cors    = require('cors');
const admin   = require('firebase-admin');
const https   = require('https');
const http    = require('http');
const app     = express();

app.use(cors());
app.use(express.json());

// ── Firebase init ─────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential:  admin.credential.cert(serviceAccount),
  databaseURL: 'https://radiobingo-9ac29-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const db        = admin.database();
const messaging = admin.messaging();

// ── Server start time ─────────────────────────────────────────
// CRITICAL: Only process notifications/messages created AFTER this moment.
// Without this, every Render restart re-processes thousands of old records.
const SERVER_START_TIME = Date.now();
console.log('[Boot] Server started at:', new Date(SERVER_START_TIME).toISOString());

// ── Webpush vibration/interaction profiles ────────────────────
const WEBPUSH_PROFILES = {
  pm:        { vibrate: [100, 50, 100],                      requireInteraction: true  },
  bingo:     { vibrate: [300, 100, 300, 100, 300, 100, 300], requireInteraction: true  },
  game_soon: { vibrate: [200, 100, 200, 100, 200],           requireInteraction: true  },
  win:       { vibrate: [100, 50, 100, 50, 100, 50, 400],    requireInteraction: true  },
  like:      { vibrate: [100],                               requireInteraction: false },
  comment:   { vibrate: [100, 50, 100],                      requireInteraction: false },
  follow:    { vibrate: [100, 50, 100],                      requireInteraction: false },
  coins:     { vibrate: [100, 50, 100, 50, 200],             requireInteraction: false },
  promo:     { vibrate: [200, 100, 200],                     requireInteraction: true  },
  system:    { vibrate: [200, 100, 200],                     requireInteraction: false }
};

// ── Notification titles ───────────────────────────────────────
const NOTIF_TITLES = {
  pm:        '💬 New Message',
  like:      '❤️ Someone liked your post',
  comment:   '💬 New comment on your post',
  share:     '🔁 Someone shared your post',
  mention:   '🏷️ You were mentioned',
  follow:    '👤 New Follower',
  bingo:     '🎱 BINGO CALL!',
  game_soon: '⏰ Game is starting soon!',
  win:       '🏆 You won!',
  coins:     '🪙 You received Coins!',
  promo:     '🎟️ You have a special promo!',
  system:    '📢 Admin Announcement',
  gift:      '🎁 You received a Gift!'
};

// ── sendPush ──────────────────────────────────────────────────
async function sendPush(token, title, body, data) {
  if (!data) data = {};
  const type    = data.type || 'system';
  const profile = WEBPUSH_PROFILES[type] || { vibrate: [200, 100, 200], requireInteraction: false };

  try {
    await messaging.send({
      token:        token,
      notification: { title: title, body: body },
      data:         Object.fromEntries(
        Object.entries(data).map(function(e) { return [e[0], String(e[1])]; })
      ),
      webpush: {
        notification: {
          icon:               'https://i.imgur.com/7D8u8h6.png',
          badge:              'https://i.imgur.com/7D8u8h6.png',
          vibrate:            profile.vibrate,
          requireInteraction: profile.requireInteraction
        },
        fcm_options: { link: '/' }
      }
    });
    console.log('[Push] ✅ Sent | type:', type, '| title:', title);
    return true;
  } catch (err) {
    console.error('[Push] ❌ Failed | code:', err.code, '| type:', type);
    // Remove stale tokens so future pushes don't fail on same token
    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      const snap = await db.ref('users').orderByChild('fcmToken').equalTo(token).once('value');
      snap.forEach(function(child) { child.ref.update({ fcmToken: null }); });
      console.log('[Push] 🗑️ Stale token removed');
    }
    return false;
  }
}

// ═════════════════════════════════════════════════════════════
//  NOTIFICATIONS LISTENER
//
//  BUG FIXED: Nested on() listeners doubled on every Render restart.
//  FIX:
//    1. Track attached UIDs in a Set — never attach twice to same user.
//    2. Filter by 'time' field (the actual field name in notifications nodes)
//       so we ONLY process notifications written after server start.
//       Old notifications with pushed:true are completely skipped.
// ═════════════════════════════════════════════════════════════
const attachedNotifUids = new Set();

db.ref('notifications').on('child_added', function(userSnap) {
  const uid = userSnap.key;

  // CRITICAL: skip if we already attached a listener for this user.
  // Without this, every Render restart re-attaches, causing duplicate pushes.
  if (attachedNotifUids.has(uid)) return;
  attachedNotifUids.add(uid);

  // Only listen to notifications with 'time' >= SERVER_START_TIME.
  // 'time' is the field name used in index.html when writing notifications.
  db.ref('notifications/' + uid)
    .orderByChild('time')
    .startAt(SERVER_START_TIME)
    .on('child_added', async function(notifSnap) {
      const notif = notifSnap.val();
      if (!notif || notif.pushed) return;

      const userRecord = await db.ref('users/' + uid).once('value');
      const user       = userRecord.val();
      if (!user || !user.fcmToken) return;

      const type  = notif.type || 'system';
      const title = NOTIF_TITLES[type] || '🔔 Radio Bingo Live';
      const body  = notif.msg  || 'You have a new notification!';

      const sent = await sendPush(user.fcmToken, title, body, {
        type:      type,
        senderUid: notif.from    || '',
        postKey:   notif.postKey || '',
        url:       notif.url     || '/'
      });

      if (sent) notifSnap.ref.update({ pushed: true });
    });
});

// ═════════════════════════════════════════════════════════════
//  MESSAGES LISTENER
//
//  BUG FIXED: child_added was firing for ALL existing messages on restart.
//  FIX: orderByChild('timestamp').startAt(SERVER_START_TIME)
//       Only new messages written after this server boot are processed.
//       'timestamp' is the field name used in index.html for messages.
// ═════════════════════════════════════════════════════════════
db.ref('messages')
  .orderByChild('timestamp')
  .startAt(SERVER_START_TIME)
  .on('child_added', async function(msgSnap) {
    const msg = msgSnap.val();
    if (!msg || !msg.to || !msg.from || msg.pushed) return;
    if (msg.from === msg.to) return;

    const recipientRecord = await db.ref('users/' + msg.to).once('value');
    const recipient       = recipientRecord.val();
    if (!recipient || !recipient.fcmToken) return;

    const senderRecord = await db.ref('users/' + msg.from).once('value');
    const sender       = senderRecord.val();
    const senderName   = sender ? (sender.name || 'Someone') : 'Someone';

    let body = 'Sent you a message';
    if      (msg.text)       body = msg.text.length > 80 ? msg.text.substring(0, 80) + '...' : msg.text;
    else if (msg.image)      body = '📷 Sent a photo';
    else if (msg.audio)      body = '🎙️ Sent a voice note';
    else if (msg.isSticker)  body = '😄 Sent a sticker';

    const sent = await sendPush(recipient.fcmToken, '💬 ' + senderName, body, {
      type:      'pm',
      senderUid: msg.from,
      url:       '/?section=messages'
    });

    if (sent) msgSnap.ref.update({ pushed: true });
  });

// ═════════════════════════════════════════════════════════════
//  KEEPALIVE — prevents Render free tier from sleeping
//
//  Render spins down after 15 min of inactivity — killing all Firebase
//  listeners silently. Self-ping every 14 min keeps the server awake.
//
//  SETUP: Add RENDER_URL env var in Render dashboard.
//  Example: https://radiobingo-push-server.onrender.com
// ═════════════════════════════════════════════════════════════
function selfPing() {
  const url = process.env.RENDER_URL;
  if (!url) return;

  try {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url + '/ping', function(res) {
      console.log('[Keepalive] ✅ Pinged self — status:', res.statusCode);
    }).on('error', function(err) {
      console.error('[Keepalive] ❌ Ping failed:', err.message);
    });
  } catch(e) {
    console.error('[Keepalive] Exception:', e.message);
  }
}

// Ping every 14 minutes (Render sleeps after 15)
setInterval(selfPing, 14 * 60 * 1000);

// ── Routes ────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.send('✅ Radio Bingo Push Server is running! Uptime: ' + Math.floor(process.uptime()) + 's');
});

// Health check endpoint (also used by keepalive ping)
app.get('/ping', function(req, res) {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), time: Date.now() });
});

// Manual test endpoint — POST { uid, title, body } to test a push
app.post('/test-push', async function(req, res) {
  const { uid, title, body } = req.body;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  const snap = await db.ref('users/' + uid).once('value');
  const user = snap.val();
  if (!user || !user.fcmToken) return res.status(404).json({ error: 'No FCM token for this user' });

  const sent = await sendPush(user.fcmToken, title || '🔔 Test', body || 'Push is working!', { type: 'system' });
  res.json({ sent: sent });
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('[Boot] Server running on port ' + PORT);
  console.log('[Boot] Listening for new notifications from:', new Date(SERVER_START_TIME).toISOString());
  // Ping once on boot so Render knows we're alive
  setTimeout(selfPing, 5000);
});

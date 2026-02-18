const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const app = express();

app.use(cors());
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://radiobingo-9ac29-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();
const messaging = admin.messaging();

// Per-type webpush config — tugma sa firebase-messaging-sw.js profiles
const WEBPUSH_PROFILES = {
  pm:        { vibrate: [100, 50, 100],                       requireInteraction: true  },
  bingo:     { vibrate: [300, 100, 300, 100, 300, 100, 300],  requireInteraction: true  },
  game_soon: { vibrate: [200, 100, 200, 100, 200],            requireInteraction: true  },
  win:       { vibrate: [100, 50, 100, 50, 100, 50, 400],     requireInteraction: true  },
  like:      { vibrate: [100],                                requireInteraction: false },
  comment:   { vibrate: [100, 50, 100],                       requireInteraction: false },
  follow:    { vibrate: [100, 50, 100],                       requireInteraction: false },
  coins:     { vibrate: [100, 50, 100, 50, 200],              requireInteraction: false },
  promo:     { vibrate: [200, 100, 200],                      requireInteraction: true  },
  system:    { vibrate: [200, 100, 200],                      requireInteraction: false }
};

async function sendPush(token, title, body, data) {
  if (!data) data = {};
  const type    = data.type || 'system';
  const profile = WEBPUSH_PROFILES[type] || { vibrate: [200, 100, 200], requireInteraction: false };

  try {
    await messaging.send({
      token: token,
      notification: { title: title, body: body },
      data: Object.fromEntries(
        Object.entries(data).map(function(entry) { return [entry[0], String(entry[1])]; })
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
    return true;
  } catch(err) {
    console.error('Push failed:', err.code, '| type:', type);
    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      const snap = await db.ref('users').orderByChild('fcmToken').equalTo(token).once('value');
      snap.forEach(function(child) { child.ref.update({ fcmToken: null }); });
    }
    return false;
  }
}

// ============================================================
// NOTIFICATION TITLES — may emoji, parang sikat na app
// ============================================================
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

// Listen sa bagong notifications
db.ref('notifications').on('child_added', function(userSnap) {
  const uid = userSnap.key;
  userSnap.ref.on('child_added', async function(notifSnap) {
    const notif = notifSnap.val();
    if (!notif || notif.pushed) return;

    const userSnap2 = await db.ref('users/' + uid).once('value');
    const user = userSnap2.val();
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

// Listen sa bagong messages
db.ref('messages').on('child_added', async function(msgSnap) {
  const msg = msgSnap.val();
  if (!msg || !msg.to || !msg.from || msg.pushed) return;
  if (msg.from === msg.to) return;

  const userSnap = await db.ref('users/' + msg.to).once('value');
  const user = userSnap.val();
  if (!user || !user.fcmToken) return;

  const senderSnap = await db.ref('users/' + msg.from).once('value');
  const sender = senderSnap.val();
  const senderName = sender ? (sender.name || 'Someone') : 'Someone';

  // Rich message preview
  let body = 'Sent you a message';
  if      (msg.text)    body = msg.text.length > 80 ? msg.text.substring(0, 80) + '...' : msg.text;
  else if (msg.image)   body = '📷 Sent a photo';
  else if (msg.audio)   body = '🎙️ Sent a voice note';
  else if (msg.isSticker) body = '😄 Sent a sticker';

  const sent = await sendPush(user.fcmToken, '💬 ' + senderName, body, {
    type:      'pm',
    senderUid: msg.from,
    url:       '/?section=messages'
  });

  if (sent) msgSnap.ref.update({ pushed: true });
});

app.get('/', function(req, res) {
  res.send('Radio Bingo Push Server is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});

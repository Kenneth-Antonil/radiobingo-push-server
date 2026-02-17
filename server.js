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

async function sendPush(token, title, body, data) {
  if (!data) data = {};
  try {
    await messaging.send({
      token: token,
      notification: { title: title, body: body },
      data: Object.fromEntries(Object.entries(data).map(function(entry) { return [entry[0], String(entry[1])]; })),
      webpush: {
        notification: {
          icon: 'https://i.imgur.com/7D8u8h6.png',
          badge: 'https://i.imgur.com/7D8u8h6.png',
          vibrate: [200, 100, 200],
          requireInteraction: data.type === 'pm' || data.type === 'bingo'
        }
      }
    });
    return true;
  } catch(err) {
    console.error('Push failed:', err.code);
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

// Listen sa bagong notifications
db.ref('notifications').on('child_added', function(userSnap) {
  const uid = userSnap.key;
  userSnap.ref.on('child_added', async function(notifSnap) {
    const notif = notifSnap.val();
    if (!notif || notif.pushed) return;

    const userSnap2 = await db.ref('users/' + uid).once('value');
    const user = userSnap2.val();
    if (!user || !user.fcmToken) return;

    let title = 'Radio Bingo Live';
    let body = notif.msg || 'May bagong notification!';

    if (notif.type === 'pm')      title = 'Bagong Message';
    else if (notif.type === 'like')    title = 'Like';
    else if (notif.type === 'comment') title = 'Komento';
    else if (notif.type === 'share')   title = 'Share';
    else if (notif.type === 'bingo')   title = 'Bingo!';
    else if (notif.type === 'mention') title = 'Na-mention ka!';
    else if (notif.type === 'system')  title = 'Announcement';

    const sent = await sendPush(user.fcmToken, title, body, {
      type: notif.type || 'general',
      from: notif.from || ''
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

  let body = 'Bagong mensahe';
  if (msg.text) {
    body = msg.text.length > 80 ? msg.text.substring(0, 80) + '...' : msg.text;
  } else if (msg.image) {
    body = 'Nagpadala ng larawan';
  }

  const sent = await sendPush(user.fcmToken, 'Message mula kay ' + senderName, body, {
    type: 'pm',
    from: msg.from
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

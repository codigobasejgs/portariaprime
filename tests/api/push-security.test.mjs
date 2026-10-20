import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validPushEndpoint, sendPush} from '../../api/_lib/channels.ts';

test('push rejeita URLs internas, userinfo, portas e domínios semelhantes sem rede', async () => {
  for (const endpoint of ['https://127.0.0.1/x','https://[::1]/x','http://fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.test/x','https://fcm.googleapis.com:8443/x',
    'https://fcm.googleapis.com@evil.test/x','https://user@fcm.googleapis.com/x','https://localhost/x']) {
    assert.equal(validPushEndpoint(endpoint), false);
    assert.equal((await sendPush({endpoint,p256dh:'x',auth:'y'},{})).status,'disabled');
  }
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x',
    'https://updates.push.services.mozilla.com/wpush/v2/x','https://web.push.apple.com/x',
    'https://wns2.notify.windows.com/x']) assert.equal(validPushEndpoint(endpoint),true);
});

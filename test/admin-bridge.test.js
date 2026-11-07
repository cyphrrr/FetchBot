// npm test — Admin-Panel: Brücken-API und öffentlicher Twitch-Rücksprung.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminServer } from '../admin.js';

let saved = null;
const ctx = {
  password: 'geheim-geheim',
  getStatus: () => ({}),
  getCommands: () => ({}),
  codeCommands: [],
  reservedNames: [],
  bridge: {
    callbackPath: '/twitch/callback',
    getState: () => ({ available: true, settings: saved ?? { enabled: false, channelId: '' } }),
    setSettings: (d) => { saved = { enabled: false, channelId: '', ...saved, ...d }; return saved; },
    connectUrl: () => 'https://id.twitch.tv/oauth2/authorize?state=abc',
    handleCallback: async (q) => {
      if (q.state !== 'gut') throw Object.assign(new Error('Anmeldung abgelaufen <script>'), { httpStatus: 400 });
      return { login: 'post_von_napoli' };
    },
    disconnect: async () => {},
    refreshMod: async () => true,
  },
};

const server = createAdminServer(ctx).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function login() {
  const res = await fetch(base + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ password: 'geheim-geheim' }),
  });
  return res.headers.get('set-cookie').split(';')[0];
}

test('Rücksprung ist ohne Login erreichbar und zeigt Erfolg', async () => {
  const res = await fetch(base + '/twitch/callback?code=x&state=gut');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('post_von_napoli'));
  assert.ok(html.includes('/#/bruecke'));
});

test('Rücksprung mit falschem state: Fehlerseite, HTML escaped', async () => {
  const res = await fetch(base + '/twitch/callback?code=x&state=boese');
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('abgelaufen <script>'));
});

test('Brücken-API nur mit Login', async () => {
  const res = await fetch(base + '/api/bridge');
  assert.equal(res.status, 401);
});

test('Brücken-API: lesen, speichern, verbinden (CSRF-Header Pflicht)', async () => {
  const cookie = await login();
  const h = { Cookie: cookie, 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };

  assert.equal((await fetch(base + '/api/bridge', { headers: { Cookie: cookie } })).status, 200);

  const noCsrf = await fetch(base + '/api/bridge', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);

  const put = await fetch(base + '/api/bridge', { method: 'PUT', headers: h, body: JSON.stringify({ enabled: true, channelId: '123456789012345678', evil: 1 }) });
  assert.equal(put.status, 200);
  assert.deepEqual(saved, { enabled: true, channelId: '123456789012345678' });

  const conn = await (await fetch(base + '/api/bridge/connect', { method: 'POST', headers: h })).json();
  assert.ok(conn.url.startsWith('https://id.twitch.tv/'));

  const mod = await (await fetch(base + '/api/bridge/modcheck', { method: 'POST', headers: h })).json();
  assert.equal(mod.isMod, true);
});

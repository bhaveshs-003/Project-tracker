/**
 * A minimal Chrome DevTools Protocol driver over a raw WebSocket.
 *
 * No puppeteer, no install — Node 20's WebSocket behind --experimental-websocket
 * is enough. Lives in the repository rather than /tmp, because the previous
 * copy was lost twice to tmp being cleared.
 */

var fs = require('fs');
var path = require('path');
var { spawn } = require('child_process');

var SHOTS = path.join(__dirname, '..', '.test-output', 'shots');

var CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  return CHROME_CANDIDATES.filter(function (p) { return fs.existsSync(p); })[0] || null;
}

var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

/** Launch headless Chrome and wait for the debugger to answer. */
async function launch(port) {
  var binary = findChrome();
  if (!binary) throw new Error('No Chrome found. Set CHROME_PATH.');

  var profile = path.join(require('os').tmpdir(), 'ft-cdp-' + Date.now());
  var child = spawn(binary, [
    '--headless=new',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--hide-scrollbars',
    '--window-size=1440,1000',
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  for (var i = 0; i < 100; i++) {
    /* eslint-disable no-await-in-loop */
    try {
      await fetch('http://127.0.0.1:' + port + '/json/version');
      return { process: child, profile: profile };
    } catch {
      await sleep(150);
    }
  }
  child.kill();
  throw new Error('Chrome did not start within 15s');
}

async function connect(port) {
  var list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  var page = list.filter(function (t) { return t.type === 'page'; })[0];

  var ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });

  var id = 0;
  var pending = new Map();
  var events = [];

  ws.onmessage = function (m) {
    var msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      var waiter = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? waiter.rej(new Error(JSON.stringify(msg.error))) : waiter.res(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };

  var send = function (method, params) {
    return new Promise(function (res, rej) {
      var myId = ++id;
      pending.set(myId, { res: res, rej: rej });
      ws.send(JSON.stringify({ id: myId, method: method, params: params || {} }));
      setTimeout(function () {
        if (pending.has(myId)) { pending.delete(myId); rej(new Error('timeout ' + method)); }
      }, 30000);
    });
  };

  await send('Page.enable');
  await send('Runtime.enable');

  return { send: send, events: events, close: function () { ws.close(); } };
}

/** Evaluate an expression, returning its value or throwing the page's error. */
async function evaluate(cdp, expression, awaitPromise) {
  var r = await cdp.send('Runtime.evaluate', {
    expression: expression, returnByValue: true, awaitPromise: !!awaitPromise
  });
  if (r.exceptionDetails) {
    throw new Error('page error: ' +
      ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) ||
        r.exceptionDetails.text));
  }
  return r.result.value;
}

async function screenshot(cdp, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  var r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  var file = path.join(SHOTS, name + '.png');
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

function setViewport(cdp, width, height) {
  return cdp.send('Emulation.setDeviceMetricsOverride',
    { width: width, height: height, deviceScaleFactor: 1, mobile: false });
}

/** Navigate and wait for the SPA to paint something matching `waitFor`. */
async function goto(cdp, url, waitFor) {
  var selector = waitFor || '#view *, #login-view:not(.hidden)';
  await cdp.send('Page.navigate', { url: url });
  await sleep(400);
  for (var i = 0; i < 60; i++) {
    /* eslint-disable no-await-in-loop */
    if (await evaluate(cdp, '!!document.querySelector(' + JSON.stringify(selector) + ')')) {
      await sleep(250);
      return;
    }
    await sleep(150);
  }
  throw new Error('never became ready: ' + url + ' (waiting for ' + selector + ')');
}

/**
 * End any session and land on the login card.
 *
 * A live session bounces /login straight to the dashboard, so simply
 * navigating there is not enough — the logout has to happen first.
 */
async function signOut(cdp, base) {
  await goto(cdp, base + '/login',
    '#login-view:not(.hidden) #login-email, #app-view:not(.hidden) .tab');

  if (await evaluate(cdp, "!document.getElementById('app-view').classList.contains('hidden')")) {
    await evaluate(cdp, "document.getElementById('logout').click(); true");
    await sleep(900);
  }
  for (var i = 0; i < 40; i++) {
    /* eslint-disable no-await-in-loop */
    if (await evaluate(cdp, "!document.getElementById('login-view').classList.contains('hidden')")) return;
    await sleep(150);
  }
  throw new Error('could not reach the login card');
}

async function login(cdp, base, email, password) {
  await signOut(cdp, base);

  await evaluate(cdp, `
    (() => {
      document.getElementById('login-email').value = ${JSON.stringify(email)};
      document.getElementById('login-password').value = ${JSON.stringify(password)};
      document.getElementById('login-form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);

  for (var j = 0; j < 80; j++) {
    /* eslint-disable no-await-in-loop */
    if (await evaluate(cdp, "!document.getElementById('app-view').classList.contains('hidden')")) {
      await sleep(500);
      return;
    }
    await sleep(150);
  }
  throw new Error('login failed for ' + email + ': ' +
    await evaluate(cdp, "document.getElementById('login-error').textContent"));
}

/** In-app navigation through the router, so there is no full reload. */
async function nav(cdp, path_) {
  await evaluate(cdp, `
    (() => { const a = document.createElement('a'); a.href = ${JSON.stringify(path_)};
      document.body.appendChild(a); a.click(); a.remove(); return true; })()`);
  await sleep(700);
}

function kill(browser) {
  try { browser.process.kill('SIGTERM'); } catch { /* already gone */ }
  // Chrome keeps writing for a moment after SIGTERM, so a straight rm races it
  // and prints "Directory not empty" on every run.
  setTimeout(function () {
    try { fs.rmSync(browser.profile, { recursive: true, force: true }); } catch { /* fine */ }
  }, 300).unref();
}

module.exports = {
  SHOTS: SHOTS, findChrome: findChrome, launch: launch, connect: connect,
  evaluate: evaluate, screenshot: screenshot, setViewport: setViewport,
  goto: goto, login: login, signOut: signOut, nav: nav, sleep: sleep, kill: kill
};

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { capture } = require('./capture');
const { loadFlow } = require('./config');
const { listPlaceholders } = require('./secrets');
const { loadTheme, validateTheme, deepMerge } = require('./theme');
const settingsStore = require('./settings');
const { launch } = require('./browser');

/**
 * A small local app for people who should not have to open a terminal.
 *
 * The whole thing is one window: type a URL, walk through the site, get a
 * video. It drives the same code the CLI does rather than reimplementing any
 * of it, so there is one pipeline to keep working.
 */

const ROOT = path.join(__dirname, '..');
const STATES = ['idle', 'capturing', 'captured', 'rendering', 'done', 'error'];

function createApp(options = {}) {
  const {
    projectDir = process.cwd(),
    flowFile = path.join(projectDir, 'flow.json'),
    outDir = path.join(projectDir, 'out'),
    settingsFile = path.join(projectDir, settingsStore.SETTINGS_FILE),
    // Injected so a test can drive a whole run without a person clicking
    // through a real site.
    captureFn = capture,
    renderFn = null,
  } = options;

  // Anything on 127.0.0.1 is reachable from any page the browser happens to
  // have open. This server can launch browsers and write files, so every call
  // has to carry a token that only the window we opened was given.
  const token = crypto.randomBytes(24).toString('hex');

  const state = {
    phase: 'idle',
    message: '',
    log: [],
    steps: [],
    videoPath: null,
    durationSec: null,
    error: null,
  };
  const listeners = new Set();

  function setPhase(phase, message = '') {
    if (!STATES.includes(phase)) throw new Error(`unknown phase ${phase}`);
    state.phase = phase;
    state.message = message;
    broadcast();
  }

  function log(line) {
    const text = String(line == null ? '' : line);
    state.log.push(text);
    if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
    broadcast();
  }

  function broadcast() {
    const payload = `data: ${JSON.stringify(publicState())}\n\n`;
    for (const res of listeners) res.write(payload);
  }

  const publicState = () => ({
    phase: state.phase,
    message: state.message,
    log: state.log,
    steps: state.steps,
    hasVideo: !!state.videoPath,
    videoName: state.videoPath ? path.basename(state.videoPath) : null,
    durationSec: state.durationSec,
    error: state.error,
  });

  /**
   * Everything the settings screen shows.
   *
   * Saved passwords are reported by name only. A value that has been stored is
   * never handed back to the page: the window is told which ones are set, and
   * that is all it needs to render the form.
   */
  function readSettings() {
    let values = {};
    let fonts = [];
    let problem = null;
    try {
      const { theme, flow } = currentConfig();
      values = settingsStore.readValues(theme, flow);
      // The font dropdowns can only offer what this theme actually declares.
      fonts = Object.entries(theme.fonts || {}).map(([key, font]) => ({
        key, family: font.family,
      }));
    } catch (err) {
      problem = friendly(err);
    }

    const stored = new Set(Object.keys(settingsStore.loadSecrets(projectDir)));
    let wanted = [];
    if (fs.existsSync(flowFile)) {
      try {
        wanted = listPlaceholders(loadFlow(flowFile));
      } catch (err) {
        // A flow that will not parse has no passwords to ask about yet, but say
        // so rather than showing an empty list as though it wanted none.
        problem = problem || friendly(err);
      }
    }
    // Anything the flow wants, plus anything already saved from before.
    const names = [...new Set([...wanted, ...stored])].sort();

    return {
      fields: settingsStore.FIELDS,
      values,
      fonts,
      problem,
      secrets: names.map((name) => ({
        name,
        set: stored.has(name),
        fromEnvironment: !!process.env[name] && !stored.has(name),
        usedByFlow: wanted.includes(name),
      })),
    };
  }

  /** The theme and flow as they stand, with the saved settings layered on. */
  function currentConfig() {
    const layer = settingsStore.loadSettings(settingsFile);
    const theme = deepMerge(loadTheme(path.join(projectDir, 'theme.json')), layer.theme);
    const flow = fs.existsSync(flowFile)
      ? Object.assign(loadFlow(flowFile), layer.flow)
      : { minStepMs: 1400, stepPaddingMs: 600, typeDelayMs: 55, ...layer.flow };
    return { theme, flow, layer };
  }

  /**
   * Save, but only once the result is known to work.
   *
   * Some combinations only break later: switching the opening card on without
   * giving it a title renders nothing and stops the run three minutes in. The
   * new values are merged onto the theme and checked here, so the form says so
   * while the person is still looking at it.
   */
  function writeSettings(values, secrets) {
    if (values) {
      const base = loadTheme(path.join(projectDir, 'theme.json'));
      const fontKeys = Object.keys(base.fonts || {});
      const layer = settingsStore.toLayer(values, { fontKeys });
      validateTheme(deepMerge(base, layer.theme), 'These settings');
      settingsStore.saveSettings(settingsFile, values, { fontKeys });
    }
    if (secrets) settingsStore.saveSecrets(projectDir, secrets);
    return readSettings();
  }

  /** Theme files sitting next to the project, for the style dropdown. */
  function listThemes() {
    return fs.readdirSync(projectDir)
      .filter((f) => /^theme.*\.json$/.test(f) && f !== 'theme.example.json')
      // theme.json first, so the dropdown opens on the default rather than on
      // whatever the filesystem happened to list first.
      .sort((a, b) => (a === 'theme.json' ? -1 : b === 'theme.json' ? 1 : a.localeCompare(b)))
      .map((file) => {
        try {
          const theme = loadTheme(path.join(projectDir, file));
          return {
            file,
            label: file.replace(/^theme-?/, '').replace(/\.json$/, '') || 'default',
            ok: true,
            detail: `${theme.video.width}x${theme.video.height}` +
              (theme.intro.enabled && theme.intro.title ? ` - "${theme.intro.title}"` : ''),
          };
        } catch (err) {
          return { file, label: file, ok: false, detail: firstLine(err.message) };
        }
      });
  }

  /** What the machine can and cannot do, checked before anything is promised. */
  async function readiness() {
    const { inspect } = require('./preflight');
    const report = await inspect();
    return {
      ffmpeg: report.ffmpeg.ok,
      ffmpegError: report.ffmpeg.error,
      browser: report.browser.ok,
      narration: report.narration,
    };
  }

  async function startCapture(url) {
    if (state.phase === 'capturing' || state.phase === 'rendering') {
      throw new Error('Something is already running.');
    }
    if (!/^https?:\/\//i.test(url || '')) {
      throw new Error('That does not look like a web address. It should start with https://');
    }
    state.log = [];
    state.error = null;
    state.videoPath = null;
    setPhase('capturing', 'A browser window is open. Walk through your site there.');

    // Deliberately not awaited: the request returns straight away and the
    // window follows along on the event stream.
    captureFn({ url, outFile: flowFile, log })
      .then(({ flow, reason }) => {
        if (reason === 'closed' && flow.steps.length <= 1) {
          state.steps = [];
          setPhase('idle', 'The browser was closed before anything was recorded.');
          return;
        }
        state.steps = flow.steps;
        setPhase('captured', `${flow.steps.length} steps recorded.`);
      })
      .catch((err) => {
        state.error = friendly(err);
        setPhase('error');
      });
  }

  async function startRender(opts = {}) {
    if (state.phase === 'rendering') throw new Error('Already making a video.');
    if (!fs.existsSync(flowFile)) throw new Error('There is no recording to render yet.');

    state.log = [];
    state.error = null;
    setPhase('rendering', 'Recording your site and putting the video together.');

    const outFile = path.join(outDir, `${slug(opts.name) || 'walkthrough'}.mp4`);
    const argv = [
      '--flow', flowFile,
      '--theme', path.join(projectDir, opts.theme || 'theme.json'),
      '--settings', settingsFile,
      '--out', outFile,
    ];
    if (!opts.narration) argv.push('--no-tts');
    argv.push(opts.captions ? '--captions' : '--no-captions');

    // Required lazily: index.js pulls in the whole pipeline, and the window
    // should open even on a machine where part of that is not usable yet.
    const { main, setOutput } = require('./index');
    const run = renderFn || main;
    setOutput(log);
    try {
      const code = await run(argv);
      if (code !== 0) throw new Error('The video could not be finished.');
      state.videoPath = outFile;
      state.durationSec = null;
      setPhase('done', 'Your video is ready.');
    } catch (err) {
      state.error = friendly(err);
      setPhase('error');
    } finally {
      setOutput(null);
    }
  }

  /** Show the finished file where the operating system shows files. */
  function revealVideo() {
    if (!state.videoPath) return false;
    const target = path.dirname(state.videoPath);
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [target], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };

    try {
      if (url.pathname === '/') {
        const html = fs.readFileSync(path.join(ROOT, 'ui', 'app.html'), 'utf8')
          .replace('__TOKEN__', token);
        return send(200, html, 'text/html; charset=utf-8');
      }

      // Everything below acts on the machine, so it needs the token.
      const given = req.headers['x-tutvid-token'] || url.searchParams.get('token');
      if (given !== token) return send(403, { error: 'Not allowed' });

      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify(publicState())}\n\n`);
        listeners.add(res);
        req.on('close', () => listeners.delete(res));
        return undefined;
      }

      if (url.pathname === '/api/settings' && req.method !== 'POST') {
        return send(200, readSettings());
      }

      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const body = await readJsonBody(req);
        return send(200, writeSettings(body.values, body.secrets));
      }

      if (url.pathname === '/api/setup') {
        return send(200, {
          themes: listThemes(),
          ready: await readiness(),
          projectDir,
          state: publicState(),
        });
      }

      if (url.pathname === '/api/capture' && req.method === 'POST') {
        const body = await readJsonBody(req);
        await startCapture(body.url);
        return send(200, { ok: true });
      }

      if (url.pathname === '/api/render' && req.method === 'POST') {
        const body = await readJsonBody(req);
        startRender(body).catch(() => {});
        return send(200, { ok: true });
      }

      if (url.pathname === '/api/reveal' && req.method === 'POST') {
        return send(200, { ok: revealVideo() });
      }

      if (url.pathname === '/api/reset' && req.method === 'POST') {
        state.error = null;
        setPhase(state.steps.length ? 'captured' : 'idle');
        return send(200, { ok: true });
      }

      if (url.pathname === '/api/video') {
        if (!state.videoPath || !fs.existsSync(state.videoPath)) return send(404, { error: 'No video' });
        const stat = fs.statSync(state.videoPath);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size });
        return fs.createReadStream(state.videoPath).pipe(res);
      }

      return send(404, { error: 'Not found' });
    } catch (err) {
      return send(400, { error: friendly(err) });
    }
  });

  return {
    server,
    token,
    listen: (port = 0) => new Promise((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        const { port: actual } = server.address();
        resolve(`http://127.0.0.1:${actual}/?token=${token}`);
      });
    }),
    close: () => new Promise((done) => server.close(done)),
    publicState,
    listThemes,
    readSettings,
    writeSettings,
    startCapture,
    startRender,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
  });
}

/** Turn an internal failure into something worth showing a colleague. */
function friendly(err) {
  const message = String(err && err.message ? err.message : err);
  if (/ELEVENLABS_API_KEY/.test(message)) {
    return 'Spoken narration needs an ElevenLabs API key. Turn narration off to make ' +
      'the video without it.';
  }
  if (/ffmpeg/i.test(message) && /not usable|not installed|missing/i.test(message)) {
    return 'ffmpeg is missing on this machine. It is needed to put the video together.';
  }
  if (/Executable doesn't exist|No usable Chromium/i.test(message)) {
    return 'The browser this tool needs has not finished downloading. Close this window ' +
      'and start the recorder again; it will fetch it.';
  }
  if (/never became visible/.test(message)) {
    return `${message}\n\nThe page probably changed since it was recorded. ` +
      'Record the walkthrough again.';
  }
  return message;
}

const firstLine = (s) => String(s).split('\n')[0];
const slug = (s) => String(s || '').trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Open the app in its own chromeless window. Falls back to whatever browser the
 * machine uses, because a window that does not appear is worse than a tab.
 */
async function openWindow(url, log = () => {}) {
  const { createWorkDir, removeWorkDir } = require('./workdir');
  const userDataDir = createWorkDir('tutvid-ui-');
  try {
    const { chromium } = require('playwright');
    const { resolveExecutablePath } = require('./browser');
    const executablePath = resolveExecutablePath();
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: null,
      ...(executablePath ? { executablePath } : {}),
      args: [`--app=${url}`, '--window-size=980,880'],
    });
    return {
      kind: 'app',
      context,
      close: async () => {
        await context.close().catch(() => {});
        removeWorkDir(userDataDir, log);
      },
    };
  } catch (err) {
    removeWorkDir(userDataDir);
    log(`could not open an app window (${firstLine(err.message)}), using the default browser`);
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
    return { kind: 'browser', close: () => {} };
  }
}

module.exports = { createApp, openWindow, friendly, slug };

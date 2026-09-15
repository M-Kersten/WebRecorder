'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { capture } = require('./capture');
const { loadFlow, readJson, ConfigError } = require('./config');
const { listPlaceholders } = require('./secrets');
const { loadTheme, validateTheme, deepMerge } = require('./theme');
const settingsStore = require('./settings');
const { launch } = require('./browser');
const shotStore = require('./shots');
const { loadVoices } = require('./voices');
const sounds = require('./sounds');
const { estimateFlow, breakdownStep } = require('./pacing');

/**
 * A small local app for people who should not have to open a terminal.
 *
 * The whole thing is one window: type a URL, walk through the site, get a
 * video. It drives the same code the CLI does rather than reimplementing any
 * of it, so there is one pipeline to keep working.
 */

const ROOT = path.join(__dirname, '..');
const STATES = ['idle', 'capturing', 'captured', 'checking', 'rendering', 'done', 'error'];

const TYPE_FOR = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
};

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
    // Injected so a test can save a narration key without reaching ElevenLabs.
    verifyKeyFn = null,
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
    // The last rehearsal, kept so the storyboard can mark the step that broke
    // rather than making somebody read a log to find it.
    check: null,
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
    check: state.check,
  });

  /**
   * Everything the settings screen shows.
   *
   * Saved passwords are reported by name only. A value that has been stored is
   * never handed back to the page: the window is told which ones are set, and
   * that is all it needs to render the form.
   */
  function readSettings(styleFile = null) {
    let values = {};
    let fonts = [];
    let voices = [];
    let problem = null;
    const style = path.basename(styleFile || currentStyle());
    try {
      const { theme, flow } = currentConfig(style);
      values = settingsStore.readValues(theme, flow);
      // The font dropdown draws every option in its own face, which means the
      // page needs the file to build an @font-face from, not just a name.
      const { labelFor } = require('./fontcatalog');
      fonts = Object.entries(theme.fonts || {})
        .map(([key, font]) => ({
          key,
          family: font.family,
          label: labelFor(font),
          file: font.path ? path.basename(font.path) : null,
          weight: font.weight,
          style: font.style,
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    } catch (err) {
      problem = friendly(err);
    }

    try {
      voices = loadVoices(projectDir);
    } catch (err) {
      // A voices.json with a typo in it should say so, and leave everything
      // else in the form usable.
      problem = problem || friendly(err);
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
    // Anything the flow wants, plus anything already saved from before. The
    // narration key is always offered: no flow asks for it, and somebody who
    // wants a spoken video has nowhere else to put it.
    const { NARRATION_KEY } = settingsStore;
    const fromFlow = [...new Set([...wanted, ...stored])]
      .filter((name) => name !== NARRATION_KEY)
      .sort();

    return {
      fields: settingsStore.FIELDS,
      style,
      styles: listThemes(),
      values,
      // Controls the chosen voice model will not act on, with the reason. The
      // API takes every setting for every model and quietly ignores the ones it
      // does not implement, so a control that does nothing looks exactly like
      // one that works until somebody wonders why their video never changes.
      inert: settingsStore.inertByModel(),
      fonts,
      voices,
      sounds: sounds.scan(projectDir),
      problem,
      secrets: [NARRATION_KEY, ...fromFlow].map((name) => ({
        name,
        role: name === NARRATION_KEY ? 'narration' : 'flow',
        set: stored.has(name),
        fromEnvironment: !!process.env[name] && !stored.has(name),
        usedByFlow: wanted.includes(name),
      })),
    };
  }

  /**
   * The walkthrough as a storyboard: one entry per step, with the picture taken
   * while it was recorded and how long it will be on screen.
   *
   * The lengths come from the same rule the recorder follows, so what the board
   * says before a render is what the render does. They are floors: a page that
   * takes four seconds to load makes its step four seconds longer, and nothing
   * here can know that yet.
   */
  function readStory() {
    const blank = { exists: false, name: '', startUrl: '', steps: [], totalMs: 0, problem: null };
    if (!fs.existsSync(flowFile)) return blank;

    let flow = null;
    let theme = null;
    try {
      ({ flow, theme } = currentConfig());
    } catch (err) {
      return { ...blank, problem: friendly(err) };
    }
    if (!Array.isArray(flow.steps) || !flow.steps.length) return blank;

    const pictures = shotStore.readManifest(flowFile);
    const timing = estimateFlow(flow, theme);
    return {
      exists: true,
      name: flow.name || '',
      startUrl: startOf(flow),
      totalMs: timing.totalMs,
      problem: null,
      steps: flow.steps.map((step, i) => ({
        index: i,
        action: step.action,
        label: step.label || '',
        target: step.selector || step.url || '',
        narration: step.narration || '',
        hint: step.hint || '',
        secret: !!step.secret,
        hasShot: !!pictures[i],
        estimateMs: timing.steps[i],
        timing: breakdownStep(step, flow, theme),
      })),
    };
  }

  /**
   * Save narration and hints back into flow.json.
   *
   * Only those two fields and the name. Selectors, typed text and the mask are
   * what the recording is; the storyboard is for writing what gets said over it,
   * and a text box has no business rewriting how a step finds its element.
   */
  function writeStory(body = {}) {
    if (!fs.existsSync(flowFile)) throw new Error('There is no recording to write for yet.');
    const raw = readJson(path.resolve(flowFile), 'flow file');
    if (!raw || !Array.isArray(raw.steps)) {
      throw new ConfigError('That flow file has no steps in it.');
    }
    if (typeof body.name === 'string' && body.name.trim()) raw.name = body.name.trim().slice(0, 120);

    for (const edit of Array.isArray(body.steps) ? body.steps : []) {
      const step = raw.steps[edit.index];
      if (!step) continue;
      for (const field of ['narration', 'hint']) {
        if (typeof edit[field] !== 'string') continue;
        const text = edit[field].replace(/\s+/g, ' ').trim();
        if (text) step[field] = text; else delete step[field];
      }
    }

    fs.writeFileSync(path.resolve(flowFile), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    state.steps = raw.steps;
    broadcast();
    return readStory();
  }

  /** Where the walkthrough starts, spelled out in full. */
  function startOf(flow) {
    const first = flow.steps.find((s) => s.action === 'goto');
    if (!first) return flow.baseUrl || '';
    try {
      return require('./recorder').resolveUrl(first.url, flow.baseUrl);
    } catch {
      return first.url || flow.baseUrl || '';
    }
  }

  /** Which style the next video is made in, and which file that is. */
  function currentStyle() {
    const chosen = settingsStore.loadSettings(settingsFile).style;
    const file = path.join(projectDir, chosen);
    return fs.existsSync(file) ? chosen : settingsStore.DEFAULT_STYLE;
  }

  /**
   * The style and flow as they stand, with the saved settings layered on.
   *
   * `styleFile` names which style to read. Left out, it is whichever one the
   * storyboard is set to, so the timings the board shows come from the style
   * the video will actually be made in.
   */
  function currentConfig(styleFile = null) {
    const style = path.basename(styleFile || currentStyle());
    const layer = settingsStore.loadSettings(settingsFile, style);
    const theme = deepMerge(loadTheme(path.join(projectDir, style)), layer.theme);
    const flow = fs.existsSync(flowFile)
      ? settingsStore.applyFlowLayer(loadFlow(flowFile), layer.flow)
      : {
        minStepMs: 1400, stepPaddingMs: 600, typeDelayMs: 55, settleMs: 600,
        timeoutMs: 15000, viewport: null,
        dismiss: { builtins: true, selectors: [], frames: [] },
        narration: true,
        voiceModel: 'eleven_multilingual_v2', voiceStyle: 0, voiceSpeed: 1,
        voiceId: null, voiceLanguage: null,
        ...layer.flow,
      };
    return { theme, flow, layer, style };
  }

  /**
   * Save, but only once the result is known to work.
   *
   * Some combinations only break later: switching the opening card on without
   * giving it a title renders nothing and stops the run three minutes in. The
   * new values are merged onto the theme and checked here, so the form says so
   * while the person is still looking at it.
   */
  async function writeSettings(values, secrets, styleFile = null) {
    // A key that ElevenLabs will not accept is worth catching here rather than
    // three minutes into a render, once the browser has walked the whole site.
    let keyCheck = null;
    const key = secrets && secrets[settingsStore.NARRATION_KEY];
    if (key) {
      const verify = verifyKeyFn || require('./tts').verifyKey;
      keyCheck = await verify(key);
      if (keyCheck.state === 'rejected') {
        throw new Error(`That does not look like a working ElevenLabs key. ${keyCheck.reason}`);
      }
    }
    const style = path.basename(styleFile || currentStyle());
    if (values) {
      const base = loadTheme(path.join(projectDir, style));
      const context = {
        fontKeys: Object.keys(base.fonts || {}),
        voiceIds: loadVoices(projectDir).map((voice) => voice.id),
        sounds: sounds.scan(projectDir).map((clip) => clip.file),
        styleFile: style,
      };
      const layer = settingsStore.toLayer(values, context);
      validateTheme(deepMerge(base, layer.theme), `These settings`);
      settingsStore.saveSettings(settingsFile, values, context);
    }
    if (secrets) settingsStore.saveSecrets(projectDir, secrets);
    return { ...readSettings(style), keyCheck };
  }

  /**
   * Start a new style from one that already works.
   *
   * A copy of the file rather than a dump of the loaded theme: the shipped
   * styles are commented documents explaining themselves, and a new one should
   * arrive with those comments intact rather than as a wall of JSON.
   */
  function createStyle(name, fromFile = null) {
    const label = String(name || '').trim();
    if (!label) throw new Error('A style needs a name.');
    const file = `theme-${slug(label)}.json`;
    if (file === 'theme-.json') throw new Error('That name has no letters or numbers in it.');
    const target = path.join(projectDir, file);
    if (fs.existsSync(target)) throw new Error(`There is already a style called "${label}".`);

    const source = path.join(projectDir, path.basename(fromFile || currentStyle()));
    if (!fs.existsSync(source)) throw new Error('The style to copy from is missing.');
    fs.copyFileSync(source, target);
    // It starts where its parent left off, edits included.
    const parent = settingsStore.loadSettings(settingsFile, path.basename(source)).theme;
    if (Object.keys(parent).length) {
      const raw = settingsStore.loadSettings(settingsFile);
      const styles = { ...raw.styles, [file]: parent };
      fs.writeFileSync(
        settingsFile,
        `${JSON.stringify({ style: raw.style, flow: raw.flow, styles }, null, 2)}\n`,
        'utf8'
      );
    }
    settingsStore.saveStyleChoice(settingsFile, file);
    return readSettings(file);
  }

  /** Which style the storyboard makes its video in, remembered between runs. */
  function chooseStyle(styleFile) {
    // A name, never a path: basename alone would leave "" pointing at the
    // project folder, which exists and is not a style.
    const file = path.basename(String(styleFile || ''));
    const target = path.join(projectDir, file);
    if (!/^theme.*\.json$/.test(file) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error(`There is no style called "${file}".`);
    }
    settingsStore.saveStyleChoice(settingsFile, file);
    broadcast();
    return file;
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

  /**
   * Whether this video gets a voice and subtitles.
   *
   * Both are settings rather than a choice made afresh each time the window
   * opens: the switches on the storyboard show what was saved, and saving one
   * in the Settings or Styles tab moves the same switch.
   */
  function renderOptions() {
    try {
      const { theme, flow } = currentConfig();
      return { narration: flow.narration !== false, captions: !!theme.captions.enabled };
    } catch {
      return { narration: true, captions: false };
    }
  }

  /** What the machine can and cannot do, checked before anything is promised. */
  async function readiness() {
    const { inspect } = require('./preflight');
    const report = await inspect({ projectDir });
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
      .then(({ flow, reason, saved }) => {
        if (saved === false || (reason === 'closed' && flow.steps.length <= 1)) {
          // Nothing was written, so whatever was on disk before is still there.
          const kept = readStory();
          state.steps = kept.exists ? loadFlow(flowFile).steps : [];
          setPhase(kept.exists ? 'captured' : 'idle',
            'The browser was closed before anything was recorded.');
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
      '--theme', path.join(projectDir, path.basename(opts.theme || currentStyle())),
      '--settings', settingsFile,
      '--out', outFile,
    ];
    // Narration and subtitles are settings, not a choice made afresh each time
    // the window opens. Whatever the switches show is what was saved, and the
    // theme and the flow already carry it, so nothing is passed here to
    // override them.
    const spoken = (() => {
      try {
        return currentConfig().flow.narration !== false;
      } catch {
        return true;
      }
    })();
    if (!spoken) argv.push('--no-tts');

    // Required lazily: index.js pulls in the whole pipeline, and the window
    // should open even on a machine where part of that is not usable yet.
    const { main, setOutput } = require('./index');
    const run = renderFn || main;
    setOutput(log);
    try {
      const code = await run(argv);
      if (code !== 0) throw new Error('The video could not be finished.');
      state.videoPath = outFile;
      state.durationSec = await measure(outFile);
      setPhase('done', 'Your video is ready.');
    } catch (err) {
      state.error = friendly(err);
      setPhase('error');
    } finally {
      setOutput(null);
    }
  }

  /**
   * Walk the recording through the site again, without making a video.
   *
   * The reason to have this in the window rather than only on the command line:
   * a walkthrough is recorded once and re-rendered for months, and the site
   * underneath it keeps moving. Finding out that a button was renamed should
   * cost twenty seconds, not a full render with a voice for every line.
   */
  async function startCheck() {
    if (state.phase === 'capturing' || state.phase === 'rendering' || state.phase === 'checking') {
      throw new Error('Something is already running.');
    }
    if (!fs.existsSync(flowFile)) throw new Error('There is no recording to check yet.');

    state.log = [];
    state.error = null;
    state.check = null;
    setPhase('checking', 'Walking through your site to see whether every step still works.');

    // Not awaited: the window follows the event stream, same as a recording.
    (async () => {
      const { rehearse, describeRehearsal } = require('./rehearse');
      const flow = loadFlow(flowFile);
      settingsStore.applyFlowLayer(flow, settingsStore.loadSettings(settingsFile, currentStyle()).flow);
      const theme = loadTheme(path.join(projectDir, path.basename(currentStyle())));
      const { sessionIsFresh, sessionPath } = require('./recorder');
      const state0 = flow.auth && sessionIsFresh(flow) ? sessionPath(flow) : null;
      const result = await rehearse(flow, theme, { storageState: state0, log });
      log('');
      log(describeRehearsal(result, flow));
      state.check = {
        ok: result.ok,
        at: Date.now(),
        steps: result.steps.map((r) => ({
          index: r.index, ok: r.ok, ms: r.ms, matches: r.matches,
          grade: r.grade || null, error: r.error || null, notes: r.notes,
        })),
        notReached: result.notReached,
      };
      setPhase('captured', result.ok
        ? `Every step still works (${(result.totalMs / 1000).toFixed(0)}s).`
        : `Step ${result.failed.index + 1} no longer works.`);
    })().catch((err) => {
      state.error = friendly(err);
      setPhase('error');
    });
  }

  /**
   * Show the work in the file manager: the finished video if there is one, and
   * the folder everything lives in if there is not.
   */
  function revealVideo() {
    const target = state.videoPath ? path.dirname(state.videoPath) : projectDir;
    if (!fs.existsSync(target)) return false;
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
      // The window asks for this and nothing serves it, which puts a 403 in
      // the console of a page that is working perfectly well.
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204).end();
        return undefined;
      }

      if (url.pathname === '/') {
        const html = fs.readFileSync(path.join(ROOT, 'ui', 'app.html'), 'utf8')
          .replace(/__TOKEN__/g, token);
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

      if (url.pathname === '/api/story' && req.method !== 'POST') {
        return send(200, readStory());
      }

      if (url.pathname === '/api/story' && req.method === 'POST') {
        return send(200, writeStory(await readJsonBody(req)));
      }

      // The picture taken while step N was recorded.
      if (url.pathname === '/api/shot') {
        const index = Number(url.searchParams.get('i'));
        const names = shotStore.readManifest(flowFile);
        const file = Number.isInteger(index) ? shotStore.fileFor(flowFile, names[index]) : null;
        if (!file) return send(404, { error: 'No screenshot for that step' });
        const stat = fs.statSync(file);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': stat.size });
        return fs.createReadStream(file).pipe(res);
      }

      // So a clip can be heard before a style is committed to it.
      if (url.pathname === '/api/sound') {
        const file = sounds.fileFor(projectDir, url.searchParams.get('name') || '');
        if (!file) return send(404, { error: 'No such clip' });
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'Content-Type': TYPE_FOR[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': stat.size,
          'Accept-Ranges': 'none',
        });
        return fs.createReadStream(file).pipe(res);
      }

      // The window is styled in the same face the videos are, which means
      // serving it from the bundle rather than hoping the machine has it.
      if (url.pathname.startsWith('/api/font/')) {
        const name = path.basename(url.pathname);
        if (!/^[A-Za-z0-9_-]+\.(?:ttf|otf)$/.test(name)) return send(404, { error: 'No such font' });
        const file = [
          path.join(projectDir, 'fonts', name),
          path.join(ROOT, 'fonts', name),
        ].find((candidate) => fs.existsSync(candidate));
        if (!file) return send(404, { error: 'No such font' });
        const stat = fs.statSync(file);
        res.writeHead(200, {
          'Content-Type': name.endsWith('.otf') ? 'font/otf' : 'font/ttf',
          'Content-Length': stat.size,
          'Cache-Control': 'max-age=3600',
        });
        return fs.createReadStream(file).pipe(res);
      }

      if (url.pathname === '/api/settings' && req.method !== 'POST') {
        const wanted = url.searchParams.get('style');
        return send(200, { ...readSettings(wanted), options: renderOptions(), ready: await readiness() });
      }

      if (url.pathname === '/api/settings' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const saved = await writeSettings(body.values, body.secrets, body.style);
        return send(200, { ...saved, options: renderOptions(), ready: await readiness() });
      }

      // Which style the next video is made in. Stored, so it survives the
      // window being closed and the CLI can be pointed at the same one.
      if (url.pathname === '/api/style' && req.method === 'POST') {
        const body = await readJsonBody(req);
        // Present but blank is still a create, so the error names the problem.
        if ('newName' in body) return send(200, createStyle(body.newName, body.from));
        // A different style can have different subtitles.
        const picked = chooseStyle(body.style);
        return send(200, { style: picked, story: readStory(), options: renderOptions() });
      }

      if (url.pathname === '/api/setup') {
        return send(200, {
          themes: listThemes(),
          style: currentStyle(),
          options: renderOptions(),
          ready: await readiness(),
          projectDir,
          state: publicState(),
          story: readStory(),
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

      if (url.pathname === '/api/check' && req.method === 'POST') {
        await startCheck();
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

  // A flow already on disk is a walkthrough somebody recorded and did not
  // finish. Open on it rather than on an empty form asking for a web address
  // they already gave once.
  try {
    const existing = readStory();
    if (existing.exists) {
      state.steps = loadFlow(flowFile).steps;
      state.phase = 'captured';
    }
  } catch {
    // A flow file that will not load is the storyboard's problem to report,
    // not a reason for the window to refuse to open.
  }

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
    readStory,
    writeStory,
    createStyle,
    chooseStyle,
    currentStyle,
  };
}

/** How long the finished file actually runs, for the storyboard to show. */
async function measure(file) {
  try {
    const { probeDuration } = require('./ffmpeg');
    return await probeDuration(file);
  } catch {
    return null;
  }
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
    return 'Spoken narration needs an ElevenLabs API key. Add one under Style, or ' +
      'turn narration off to make the video without it.';
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
      args: [`--app=${url}`, '--window-size=1240,900'],
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

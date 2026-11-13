const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

require('dotenv').config({ path: path.join(__dirname, '.env') });

function getUrls() {
  const raw = process.env.TARGET_URLS || '';
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    values = raw.split(/\r?\n/);
  }
  if (!Array.isArray(values)) throw new Error('TARGET_URLS mora biti JSON seznam ali seznam URL-jev po vrsticah.');
  return [...new Set(values.map((value) => {
    if (typeof value !== 'string') throw new Error('Vsak TARGET_URLS vnos mora biti URL niz.');
    return value.trim();
  }).filter(Boolean))].map((value) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Nepodprt URL: ${value}`);
    return value;
  });
}

const children = new Set();
let stopping = false;
let launchTimer;

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(launchTimer);
  for (const child of children) child.kill('SIGTERM');
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function launch(url, index) {
  const label = `bot ${index + 1}`;
  console.log(`[${label}] Zagon: ${url}`);
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd: __dirname,
    env: { ...process.env, TARGET_URLS: JSON.stringify([url]) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => output.write(`[${label}] ${line}\n`));
  }
  child.on('error', (error) => {
    console.error(`[${label}] Zagon ni uspel: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    children.delete(child);
    console.log(`[${label}] Ustavljen (${signal || code}).`);
    if (!stopping && code !== 0) process.exitCode = 1;
  });
}

try {
  const urls = getUrls();
  if (!urls.length) throw new Error('V .env ni nastavljen TARGET_URLS.');
  const delay = Number(process.env.BOT_START_DELAY_MS || 5000);
  if (!Number.isFinite(delay) || delay < 0 || delay > 2147483647) {
    throw new Error('BOT_START_DELAY_MS mora biti veljavno nenegativno stevilo milisekund.');
  }
  console.log(`Zaganjam ${urls.length} locenih botov. Ctrl+C ustavi vse procese.`);
  console.warn('Boti trenutno uporabljajo skupni data.json; ta skripta ne spreminja shranjevanja podatkov.');
  let index = 0;
  function next() {
    if (stopping) return;
    launch(urls[index], index);
    index++;
    if (index < urls.length) launchTimer = setTimeout(next, delay);
  }
  next();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  stop();
}

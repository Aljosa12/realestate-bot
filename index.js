require('dotenv').config();
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
const fs = require('fs');
const path = require('path');
const DATA_FILE = path.join(__dirname, 'data.json');
const MIN_PRICE = Number(process.env.MIN_PRICE || 190000);
const MAX_PRICE = Number(process.env.MAX_PRICE || 450000);
const CONCURRENCY = Math.max(1, Number(process.env.SCRAPE_CONCURRENCY || 1));
const MAX_RETRIES = Math.max(0, Number(process.env.SCRAPE_MAX_RETRIES || 8));
const REQUEST_DELAY_MS = Math.max(0, Number(process.env.SCRAPE_DELAY_MS || 2000));
const DEFAULT_RETRY_DELAY_MS = Math.max(1000, Number(process.env.SCRAPE_RETRY_DELAY_MS || 30000));

function getTargetUrls() {
  const urls = [];
  if (process.env.TARGET_URLS) {
    try {
      const parsed = JSON.parse(process.env.TARGET_URLS);
      if (!Array.isArray(parsed)) throw new Error('TARGET_URLS must be an array');
      urls.push(...parsed);
    } catch {
      urls.push(...process.env.TARGET_URLS.split(/\r?\n/));
    }
  }
  return [...new Set(urls.filter(Boolean))];
}

const TARGET_URLS = getTargetUrls();
let knownProperties = new Set();
let checkInProgress = false;

// Load previous known properties if exists
if (fs.existsSync(DATA_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(saved)) knownProperties = new Set(saved);
  } catch (error) {
    console.error('Napaka pri branju data.json:', error.message);
  }
}

function parsePrice(text) {
  const match = text.match(/([\d.]+(?:,\d{1,2})?)/);
  if (!match) return null;
  const price = Number(match[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(price) ? price : null;
}

function parseProperties(html, sourceUrl) {
  const $ = cheerio.load(html);
  const properties = [];
  $('.property-box').each((i, el) => {
    const title = $(el).find('.url-title-d').text().trim();
    const description = $(el).find('p').text().trim();
    const priceText = $(el).find('h6').text().trim();
    const rawLink = $(el).find('a').attr('href');
    const price = parsePrice(priceText);
    let link = rawLink;
    try {
      if (rawLink) link = new URL(rawLink, sourceUrl).href;
    } catch { }
    // Keep the old ID format so existing data.json entries do not trigger again.
    const uniqueId = rawLink || title;
    if (uniqueId && price !== null) {
      properties.push({ uniqueId, title, description, priceText, price, link });
    }
  });
  return properties;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(response, html, attempt) {
  const retryAfter = response?.headers()?.['retry-after'];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);

    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(1000, date - Date.now());
  }

  const bodyMatch = html?.match(/retry\s+after\s+(\d+)/i);
  if (bodyMatch) return Math.max(1000, Number(bodyMatch[1]) * 1000);
  return Math.min(DEFAULT_RETRY_DELAY_MS * (attempt + 1), 5 * 60 * 1000);
}

async function scrapeUrl(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        const html = await page.content();
        const status = response?.status();
        const retryable = status === 429 || (status >= 500 && status <= 599) ||
          /too many requests/i.test(html);

        if (!retryable) {
          if (status && status >= 400) throw new Error(`HTTP ${status}`);
          return parseProperties(html, url);
        }
        if (attempt === MAX_RETRIES) {
          throw new Error(`HTTP ${status || 429}: doseženo največje število ponovnih poskusov`);
        }

        const delayMs = getRetryDelayMs(response, html, attempt);
        console.warn(`HTTP ${status || 429} za ${url}; ponovni poskus ${attempt + 1}/${MAX_RETRIES} čez ${Math.ceil(delayMs / 1000)} s.`);
        await sleep(delayMs);
      } catch (error) {
        if (/^HTTP \d+/.test(error.message) || attempt === MAX_RETRIES) throw error;
        const delayMs = Math.min(DEFAULT_RETRY_DELAY_MS * (attempt + 1), 5 * 60 * 1000);
        console.warn(`Začasna napaka za ${url}: ${error.message}; ponovni poskus ${attempt + 1}/${MAX_RETRIES} čez ${Math.ceil(delayMs / 1000)} s.`);
        await sleep(delayMs);
      }
    }
  } finally {
    await page.close();
  }
}

async function scrapeAllUrls(browser) {
  const results = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < TARGET_URLS.length) {
      const url = TARGET_URLS[nextIndex++];
      try {
        results.push(...await scrapeUrl(browser, url));
      } catch (error) {
        console.error(`Napaka pri preverjanju ${url}:`, error.message);
      }
      if (nextIndex < TARGET_URLS.length && REQUEST_DELAY_MS > 0) {
        await sleep(REQUEST_DELAY_MS);
      }
    }
  }
  const count = Math.min(CONCURRENCY, TARGET_URLS.length);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function checkWebsite() {
  if (checkInProgress) {
    console.log('Prejšnje preverjanje še poteka; preskakujem ta cikel.');
    return;
  }
  if (TARGET_URLS.length === 0) {
    console.error('V .env ni nastavljen noben TARGET_URL ali TARGET_URLS.');
    return;
  }

  checkInProgress = true;
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true });
    const scraped = await scrapeAllUrls(browser);
    const properties = new Map(scraped.map((property) => [property.uniqueId, property]));
    let dataChanged = false;

    for (const property of properties.values()) {
      if (knownProperties.has(property.uniqueId) ||
        property.price <= MIN_PRICE || property.price >= MAX_PRICE) continue;

      const { title, description, link } = property;
      const priceStr = property.priceText;

      const message = `Zaznana nova lokacija:\n${title}\n${priceStr}\n${description}\n${link || ''}`;
      try {
        await bot.sendMessage(process.env.CHAT_ID, message);
        knownProperties.add(property.uniqueId);
        dataChanged = true;
      } catch (error) {
        console.error(`Telegram sporočila ni bilo mogoče poslati (${property.uniqueId}):`, error.message);
      }
    }

    if (dataChanged) fs.writeFileSync(DATA_FILE, JSON.stringify([...knownProperties], null, 2));
    console.log(`Preverjenih filtrov: ${TARGET_URLS.length}; unikatnih oglasov: ${properties.size}.`);
  } catch (err) {
    console.error('Napaka:', err.message);
  } finally {
    if (browser) await browser.close();
    checkInProgress = false;
  }
}

// preveri vsakih 5 minut
cron.schedule('*/5 * * * *', checkWebsite);

console.log(`Real estate bot is running (${TARGET_URLS.length} filtrov).`);
checkWebsite();

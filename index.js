/**
 * GAME Bot v2.0 — Intelligence Upgrade
 *
 * CHANGELOG vs v7.0 (Claude migration):
 * ─ SSB bot: active: false (код сохранён)
 * ─ GAME: убраны keywords, добавлен role-based поиск по истории
 * ─ Взвешенная ротация источников: 6 RU + 3 INT + 1 Research
 * ─ Чтение TG-каналов через t.me/s/ (каждый 3й прогон)
 * ─ 5 типов постов с жёсткими структурами и запретами
 * ─ Расширенная история: type, region, mechanic, industry
 * ─ Окно новостей: 72ч вместо 48ч
 * ─ Новые источники: RU (+5), INT (+13 включая Азию), Research (+8)
 * ─ Удалены мёртвые сайты: badgeville, bunchball, chinanews, sohu и др.
 *
 * ENV VARS (не изменились):
 * ─ ANTHROPIC_API_KEY
 * ─ TELEGRAM_TOKEN_GAM / TELEGRAM_CHAT_ID_GAM
 * ─ TELEGRAM_TOKEN_BAT / TELEGRAM_CHAT_ID_BAT (неактивен)
 * ─ GITHUB_TOKEN / GIST_ID
 */

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────
// ИСТОЧНИКИ (разбиты по уровням)
// ─────────────────────────────────────────────────────────
const SOURCES = {
  // Приоритет 1 — Россия и СНГ (6 слотов в ротации)
  RU: [
    "site:vc.ru",
    "site:retail.ru",
    "site:cossa.ru",
    "site:sostav.ru",
    "site:adindex.ru",
    "site:oborot.ru",
    "site:kts.tech",
    "site:retail-loyalty.org",
    "site:gamification-now.ru",
    "site:cyberleninka.ru",
    "site:app2top.ru",
    "site:rb.ru",
    "site:habr.com",
    "site:tadviser.ru",
    "site:marketmedia.ru",
    "site:cnews.ru"
  ],

  // Приоритет 2 — Международные: США/Европа + Азия (3 слота в ротации)
  INT: [
    // США / Европа
    "site:techcrunch.com",
    "site:hbr.org",
    "site:mckinsey.com",
    "site:loyalty360.org",
    "site:thewisemarketer.com",
    "site:marketingweek.com",
    "site:adweek.com",
    "site:digiday.com",
    "site:nielsen.com",
    "site:newzoo.com",
    "site:sensortower.com",
    "site:data.ai",
    "site:econsultancy.com",
    "site:forrester.com",
    "site:businessofapps.com",
    "site:euromonitor.com",
    "site:openloyalty.io",
    // Азия — Китай
    "site:36kr.com",
    "site:woshipm.com",
    "site:199it.com",
    "site:walkthechat.com",
    // Азия — ЮВА и Индия
    "site:techwireasia.com",
    "site:inc42.com",
    "site:kr-asia.com",
    "site:e27.co",
    "site:techinasia.com",
    "site:restofworld.org",
    // Азия — Япония, Корея
    "site:kakaocorp.com",
    "site:linecorp.com"
  ],

  // Приоритет 3 — Исследования и методология (1 слот в ротации)
  RESEARCH: [
    "site:frontiersin.org",
    "site:mdpi.com",
    "site:behavioraleconomics.com",
    "site:nngroup.com",
    "site:bond-brandloyalty.com",
    "site:nirandfar.com",
    "site:yukaichou.com",
    "site:researchgate.net"
  ]
};

function shuffle(arr) {
  return [...arr].sort(() => 0.5 - Math.random());
}

function buildSearchScope(isFreeSearch) {
  if (isFreeSearch) return { scope: "", mode: "FREE ROAM" };
  const ru   = shuffle(SOURCES.RU).slice(0, 6);
  const int_ = shuffle(SOURCES.INT).slice(0, 3);
  const res  = shuffle(SOURCES.RESEARCH).slice(0, 1);
  return {
    scope: [...ru, ...int_, ...res].join(' OR '),
    mode: "WEIGHTED (6·RU + 3·INT + 1·RES)"
  };
}

// ─────────────────────────────────────────────────────────
// PERSONA — GAME BOT
// ─────────────────────────────────────────────────────────
const GAME_PERSONA = `Ты — Ведущий стратег по геймификации и поведенческой экономике с фокусом на бизнес-применение.
ТОН: Живой и точный. Не сухой академизм, но и не развлекательный контент. Пишешь как практик с данными в руках.
АУДИТОРИЯ: Продакты, маркетологи, предприниматели — те, кто внедряет игровые механики или только рассматривает их.

ПРИОРИТЕТЫ ПОИСКА (строго в таком порядке):
1. Российский и СНГ рынок — искать ПЕРВЫМ делом
2. Азия (Китай, Индия, ЮВА) — если нет актуального RU-контента
3. США / Европа — только если нет ничего лучше из регионов выше

ТЕМАТИКА (ищи всё это, не только кейсы):
- Кейсы геймификации: ритейл, банки, HR, EdTech, здоровье
- Исследования: лояльность, вовлечённость, retention, мотивация
- Методологии: Octalysis, SDT, Hooked, BJ Fogg, игровые петли
- Новости: запуски программ лояльности, геймифицированных продуктов
- Тренды и аналитика рынка геймификации

═══════════════════════════
5 ФОРМАТОВ ПОСТА — выбери один исходя из найденного материала:

[ТИП: КЕЙС] — конкретная компания, механика, цифры
1. Факт-зацепка: что именно сделала компания (не "внедрила геймификацию", а конкретно)
2. Механика: как именно работает (points/badges/challenges/levels — детально)
3. Цифры: минимум 1 метрика обязательна (+34% DAU, -12% churn, x2 retention)
4. Нетривиальная мысль: что это значит, почему не очевидно — 1-2 предложения

[ТИП: ИССЛЕДОВАНИЕ] — академическая работа или отраслевой отчёт
1. Неочевидная находка из исследования
2. Противоречие с тем, что принято считать (или неожиданное подтверждение)
3. Практический вывод для бизнеса: что с этим делать

[ТИП: НОВОСТЬ] — событие, запуск, сделка, партнёрство
1. Факт: что произошло
2. Контекст: почему сейчас и что изменилось
3. На что смотреть дальше: одна конкретная вещь

[ТИП: ТЕОРИЯ] — разбор механики, фреймворка, концепции
1. Суть концепции в одном предложении (без воды)
2. Пример применения из реальной практики
3. Граница применимости или открытый вопрос

[ТИП: КОММЕНТАРИЙ] — реакция на тему из профессионального сообщества
1. Тезис из сообщества (обезличенно, без упоминания канала)
2. Что говорят данные и исследования
3. Своя позиция — точка зрения, не нейтральная каша

═══════════════════════════
ЖЁСТКИЕ ЗАПРЕТЫ — нарушение = искать другой материал:
- НЕ заканчивать: "таким образом", "итого", "подводя итог", "в заключение", "геймификация в очередной раз доказала"
- НЕ начинать: "В мире геймификации...", "Геймификация снова...", "Как известно..."
- КЕЙС без хотя бы одной конкретной цифры — не публиковать
- НЕ повторять индустрию из последних 2 постов (смотри историю)
- НЕ повторять регион из последнего поста (смотри историю)
- НЕ повторять механику из последних 2 постов (смотри историю)
- НЕ писать "революционный", "уникальный", "инновационный" без цифр или доказательств

ДЛИНА ПОСТА: 4–7 предложений. Один абзац или два коротких.

ФОРМАТ ТЕКСТА: только чистый текст, без какой-либо разметки.
- Никаких HTML-тегов (<b>, <cite>, <a> и т.д.)
- Никакого markdown (**, *, #, __)
- Никаких эмодзи
- Просто текст, который будет читаться как абзац`;

// ─────────────────────────────────────────────────────────
// КОНФИГУРАЦИЯ
// ─────────────────────────────────────────────────────────
const CONFIG = {
  topics: [
    {
      id: "SSB",
      name: "Твердотельные Батареи (R&D)",
      active: false, // ОТКЛЮЧЁН. Код сохранён для будущего использования.
      channelId: "process.env.TELEGRAM_CHAT_ID_BAT",
      botToken: "process.env.TELEGRAM_TOKEN_BAT",
      keywords: [
        "Solid-State Battery", "Sulfide Electrolyte", "Anode-free lithium metal",
        "Dry electrode coating", "All-solid-state battery mass production",
        "Toyota Solid State", "QuantumScape", "Solid Power", "LFP cathode evolution", "Silicon anode"
      ],
      whitelist: "site:global.toyota OR site:samsungsdi.com OR site:catl.com OR site:quantumscape.com OR site:solidpowerbattery.com OR site:nature.com OR site:sciencedirect.com OR site:electrek.co OR site:pushevs.com OR site:asia.nikkei.com OR site:businesswire.com OR site:bloomberg.com/energy OR site:reuters.com/business/energy OR site:joule.cell.com OR site:pubs.acs.org OR site:onlinelibrary.wiley.com OR site:electrochem.org OR site:insideevs.com OR site:battery-news.com OR site:mining.com OR site:prologium.com OR site:ses.ai OR site:factorialenergy.com OR site:gotion.com.cn OR site:ganfenglithium.com OR site:welion.com.cn OR site:blue-solutions.com OR site:store-dot.com OR site:amprius.com OR site:sila.com OR site:group14.technology OR site:enovix.com OR site:sk-on.com OR site:lgensol.com OR site:panasonic.com/global/energy OR site:northvolt.com OR site:freyrbattery.com OR site:morrowbatteries.com OR site:verkor.com OR site:acc-emotion.com OR site:powerco.de OR site:calb-tech.com OR site:svolt.cn OR site:farasis.com OR site:sunwoda.com OR site:argonne.gov OR site:nrel.gov",
      personaName: "R&D Engineer",
      personaPrompt: `Ты — Ведущий R&D инженер по химическим источникам тока (Senior Battery Scientist).
ТОН: Сухой, критический, циничный. Веришь только цифрам и результатам тестов.
ФОКУС: Wh/kg, Wh/L, $/kWh, Cycle life, дендриты, интерфейс электролит-катод.
ИГНОРИРОВАТЬ: маркетинговый шум без спецификаций.`,
      schedule: "*/20 * * * *"
    },
    {
      id: "GAME",
      name: "Геймификация в Бизнесе",
      active: true,
      channelId: "process.env.TELEGRAM_CHAT_ID_GAM",
      botToken: "process.env.TELEGRAM_TOKEN_GAM",
      // keywords удалены — Claude сам решает что искать на основе истории
      tgChannels: [
        "not_so_aaa_games",
        "bodyavprode",
        "interactivespec",
        "schrodingerproduct",
        "leska_agency",
        "dima_igrotech",
        "pm_gurgen"
      ],
      personaName: "Game Strategist",
      personaPrompt: GAME_PERSONA,
      schedule: "*/20 * * * *"
    }
  ]
};

if (!process.env.ANTHROPIC_API_KEY) console.error("!!! NO ANTHROPIC_API_KEY !!!");
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────
// СОСТОЯНИЕ
// ─────────────────────────────────────────────────────────
let articles     = [];
let logs         = [];
let postedTitles = new Set();
let postHistory  = []; // [{title, type, region, mechanic, industry, ts}]
let lastRunTime  = 0;
let runCounter   = 0;

// ─────────────────────────────────────────────────────────
// ЛОГИ
// ─────────────────────────────────────────────────────────
const addLog = (tag, msg) => {
  const entry = `[${new Date().toLocaleTimeString('ru-RU')}] [${tag}] ${msg}`;
  logs.unshift(entry);
  if (logs.length > 50) logs.pop();
  console.log(entry);
};

// ─────────────────────────────────────────────────────────
// GIST — загрузка (с миграцией старого формата)
// ─────────────────────────────────────────────────────────
async function loadGist() {
  if (!process.env.GITHUB_TOKEN || !process.env.GIST_ID) {
    addLog("GIST", "Нет токенов. Работаем в памяти.");
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, {
      headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}` }
    });
    const data = await res.json();
    if (!data.files?.['history.json']) { addLog("GIST", "Файл history.json не найден."); return; }

    const stored = JSON.parse(data.files['history.json'].content);

    // Миграция: старый формат — просто массив строк
    if (Array.isArray(stored)) {
      stored.forEach(item => {
        if (typeof item === 'string') {
          postedTitles.add(item);
        } else if (item?.title) {
          postedTitles.add(item.title);
          postHistory.push(item);
        }
      });
      addLog("GIST", `Загружено ${postedTitles.size} (старый формат, конвертировано).`);
    } else {
      // Новый формат: {titles: [], posts: []}
      (stored.titles || []).forEach(t => postedTitles.add(t));
      postHistory = stored.posts || [];
      addLog("GIST", `Загружено ${postedTitles.size} постов + ${postHistory.length} записей истории.`);
    }
  } catch (e) {
    addLog("GIST_ERROR", "Ошибка загрузки: " + e.message);
  }
}

// ─────────────────────────────────────────────────────────
// GIST — сохранение (новый расширенный формат)
// ─────────────────────────────────────────────────────────
async function saveGist() {
  if (!process.env.GITHUB_TOKEN || !process.env.GIST_ID) return;
  try {
    const content = JSON.stringify({
      titles: Array.from(postedTitles),
      posts: postHistory.slice(-50)
    });
    await fetch(`https://api.github.com/gists/${process.env.GIST_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ files: { 'history.json': { content } } })
    });
    addLog("GIST", "Сохранено.");
  } catch (e) {
    addLog("GIST_ERROR", "Ошибка сохранения: " + e.message);
  }
}

loadGist();

// ─────────────────────────────────────────────────────────
// ENV RESOLVER
// ─────────────────────────────────────────────────────────
const resolveEnv = (val) => {
  if (typeof val === 'string' && val.startsWith('process.env.')) {
    const key = val.replace('process.env.', '');
    const v = process.env[key];
    if (!v) console.warn(`WARNING: Missing ENV variable: ${key}`);
    return v || val;
  }
  return val;
};

// ─────────────────────────────────────────────────────────
// TELEGRAM — отправка сообщения
// ─────────────────────────────────────────────────────────
async function sendMessageToTelegram(chatId, token, text) {
  const actualToken  = resolveEnv(token);
  const actualChatId = resolveEnv(chatId);

  if (!actualToken  || actualToken.startsWith('process.env'))
    return { ok: false, description: "Missing Token" };
  if (!actualChatId || actualChatId.startsWith('process.env'))
    return { ok: false, description: "Missing Chat ID" };

  try {
    const r = await fetch(`https://api.telegram.org/bot${actualToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: actualChatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

// ─────────────────────────────────────────────────────────
// TELEGRAM — чтение публичных каналов через t.me/s/
// ─────────────────────────────────────────────────────────
async function fetchTelegramPosts(channelName) {
  try {
    const res = await fetch(`https://t.me/s/${channelName}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
      }
    });
    if (!res.ok) { addLog("TG_FETCH", `${channelName}: HTTP ${res.status}`); return []; }
    const html = await res.text();

    // Извлекаем тексты постов из HTML Telegram web preview
    const matches = [
      ...html.matchAll(
        /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div class="tgme_widget_message_footer)/g
      )
    ];

    return matches
      .map(m =>
        m[1]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      )
      .filter(t => t.length > 60)
      .slice(-5); // Последние 5 постов
  } catch (e) {
    addLog("TG_FETCH", `Ошибка ${channelName}: ${e.message}`);
    return [];
  }
}

async function fetchAllTgChannels(channels) {
  const results = [];
  for (const ch of channels) {
    const posts = await fetchTelegramPosts(ch);
    if (posts.length > 0) {
      results.push({ channel: ch, posts });
      addLog("TG_FETCH", `@${ch}: ${posts.length} постов`);
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────
// ИСТОРИЯ — форматирование для промпта
// ─────────────────────────────────────────────────────────
function buildHistorySummary(limit = 15) {
  const recent = postHistory.slice(-limit);
  if (recent.length === 0) return "История пуста — можно писать о чём угодно.";
  return recent
    .map((p, i) =>
      `${i + 1}. [${p.type || '?'}] [${p.region || '?'}] [${p.mechanic || '?'}] [${p.industry || '?'}] — "${(p.title || '').slice(0, 55)}"`
    )
    .join('\n');
}

// ─────────────────────────────────────────────────────────
// URL — извлечение из ответа Claude
// ─────────────────────────────────────────────────────────
function extractUrl(content) {
  for (const block of content) {
    if (block.type === 'text') {
      const m = block.text.match(/https?:\/\/[^\s"'<>)\]]+/);
      if (m) return m[0];
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
// MAIN DISCOVERY
// ─────────────────────────────────────────────────────────
async function runDiscovery(tag = "AUTO") {
  const now = Date.now();
  if (now - lastRunTime < 3 * 60 * 1000) {
    addLog(tag, "Кулдаун (3 мин)...");
    return;
  }
  lastRunTime = now;
  runCounter++;

  const activeTopics = CONFIG.topics.filter(t => t.active);
  if (activeTopics.length === 0) { addLog(tag, "Нет активных топиков."); return; }

  const topic = activeTopics[Math.floor(Math.random() * activeTopics.length)];
  const isFreeSearch = Math.random() < 0.25;
  const { scope, mode } = buildSearchScope(isFreeSearch);

  addLog(tag, `[${topic.id}] ${mode} | прогон #${runCounter}`);

  // ── TG-каналы: каждый 3й прогон ──
  let tgContext = "";
  if (topic.tgChannels?.length && runCounter % 3 === 0) {
    addLog(tag, `Читаем ${topic.tgChannels.length} TG-каналов...`);
    const tgData = await fetchAllTgChannels(topic.tgChannels);
    if (tgData.length > 0) {
      tgContext = `

СВЕЖИЙ КОНТЕНТ ИЗ ПРОФЕССИОНАЛЬНЫХ TG-КАНАЛОВ:
${tgData.map(d => `[@${d.channel}]\n${d.posts.join('\n---\n')}`).join('\n\n')}

ИНСТРУКЦИЯ ПО TG-КОНТЕНТУ:
- Если видишь кейс/новость с конкретной компанией: найди публичное подтверждение через поиск. Нашёл — пост со ссылкой на публичный источник. Не нашёл — пропускай.
- Если видишь теорию, фреймворк или мнение: напиши пост [ТИП: КОММЕНТАРИЙ], ссылку дай на исследование, а не на TG.
- Если это реклама, оффтоп, самопиар — игнорируй.
- Названия TG-каналов в посте НЕ упоминать.`;
    }
  }

  // ── Строим промпт ──
  const historySummary = buildHistorySummary(15);
  const excludedTitles = Array.from(postedTitles).slice(-50).join(' | ');

  const systemPrompt = `${topic.personaPrompt}

ТЕКУЩАЯ ДАТА: ${new Date().toISOString()}
ВРЕМЕННОЕ ОКНО: Материал не старше 72 часов.`;

  const userPrompt = `ИСТОРИЯ ПОСЛЕДНИХ ПОСТОВ (НЕ ПОВТОРЯТЬ):
${historySummary}

ЗАДАЧА:
1. Посмотри на историю. Определи, чего давно не было по каждому параметру:
   - тип: case / research / news / theory / community
   - регион: ru / us / asia / global
   - механика: points / badges / levels / challenges / leaderboard / narrative
   - индустрия: retail / fintech / hr / edtech / health
2. Найди контент, который заполняет наибольший пробел.
3. Напиши пост строго по структуре выбранного типа из промпта.
${tgContext}

ОБЛАСТЬ ПОИСКА: ${scope || "Весь интернет"}
ИСКЛЮЧИТЬ (уже опубликовано): [${excludedTitles}]

ВАЖНО: твой ответ должен начинаться с символа "[" и заканчиваться символом "]". Никакого текста до или после. Только JSON-массив:
[{
  "title": "краткий заголовок",
  "telegramPost": "текст поста на русском",
  "sourceUrl": "прямая ссылка на источник",
  "type": "case|research|news|theory|community",
  "region": "ru|us|asia|global",
  "mechanic": "points|badges|levels|challenges|leaderboard|narrative|other",
  "industry": "retail|fintech|hr|edtech|health|other"
}]`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: userPrompt }]
    });

    const rawText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    let items = [];
    try {
      // Strip markdown fences
      let cleaned = rawText.replace(/```json|```/g, '').trim();
      // If Claude added text before the JSON array, extract just the [...] part
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) cleaned = arrayMatch[0];
      items = JSON.parse(cleaned);
    } catch {
      addLog(tag, `JSON parse error. Raw: ${rawText.slice(0, 200)}`);
      return;
    }

    if (!Array.isArray(items) || items.length === 0) {
      addLog(tag, "Пусто — нет подходящего материала.");
      return;
    }

    const item = items[0];
    const groundingUrl = item.sourceUrl || extractUrl(response.content);

    if (!groundingUrl)             { addLog(tag, "Нет источника — пропуск."); return; }
    if (postedTitles.has(item.title)) { addLog(tag, "Дубль — пропуск.");      return; }

    // Зачищаем текст поста от любой разметки — Claude должен слать чистый текст,
    // но на всякий случай убираем всё лишнее
    let safePost = item.telegramPost
      .replace(/<[^>]+>/g, '')           // убрать все HTML теги
      .replace(/\*\*(.*?)\*\*/g, '$1')  // убрать markdown bold
      .replace(/\*(.*?)\*/g, '$1')       // убрать markdown italic
      .replace(/#{1,3}\s?/g, '')          // убрать markdown заголовки
      .replace(/_{2}(.*?)_{2}/g, '$1')    // убрать markdown underline
      .trim();

    // Эмодзи по типу поста
    const typeEmoji = {
      case:      '📊',
      research:  '🔬',
      news:      '📰',
      theory:    '💡',
      community: '💬'
    }[item.type] || '📌';

    // Собираем финальное сообщение с чистой структурой
    const message = `${typeEmoji} <b>${item.title}</b>\n\n${safePost}\n\n<a href="${groundingUrl}">🔗 Источник</a>`;

    addLog(tag, `Отправка [${item.type}|${item.region}|${item.mechanic}|${item.industry}]`);

    const tgRes = await sendMessageToTelegram(topic.channelId, topic.botToken, message);

    if (tgRes.ok) {
      postedTitles.add(item.title);
      const meta = {
        title:    item.title,
        type:     item.type     || 'unknown',
        region:   item.region   || 'global',
        mechanic: item.mechanic || 'other',
        industry: item.industry || 'other',
        ts: Date.now()
      };
      postHistory.push(meta);
      saveGist();

      articles.unshift({
        id: Date.now().toString(),
        title: item.title,
        sourceDomain: topic.id,
        sourceUrl: groundingUrl,
        type: item.type,
        region: item.region
      });
      addLog("POST", `OK [${item.type}|${item.region}] ${item.title.slice(0, 45)}...`);
    } else {
      addLog("ERROR", `TG Error: ${tgRes.description}`);
    }

  } catch (err) {
    addLog("ERROR", `Сбой: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────
app.post('/api/sync', (req, res) => {
  if (req.body.titles) {
    req.body.titles.forEach(t => postedTitles.add(t));
    addLog("SYNC", `${req.body.titles.length} статей.`);
  }
  res.json({ ok: true });
});

app.get('/api/keep-alive', (req, res) => {
  addLog("CRON", "Пинг.");
  res.json({ status: "alive" });
});

app.get('/api/trigger', (req, res) => {
  runDiscovery("USER");
  res.json({ status: "triggered" });
});

app.get('/api/articles', (req, res) => res.json(articles));

app.get('/api/status', (req, res) => res.json({
  logs,
  online: true,
  runCounter,
  historySize: postHistory.length,
  recentPosts: postHistory.slice(-10)
}));

// ─────────────────────────────────────────────────────────
// CRON — автозапуск по расписанию из конфига
// ─────────────────────────────────────────────────────────
CONFIG.topics
  .filter(t => t.active && t.schedule)
  .forEach(topic => {
    cron.schedule(topic.schedule, () => {
      addLog("CRON", `Автозапуск [${topic.id}]`);
      runDiscovery("CRON");
    });
    addLog("SYS", `Cron [${topic.id}]: ${topic.schedule}`);
  });

// ─────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  addLog("SYS", "GAME Bot v2.0 Online — cron активен");
});

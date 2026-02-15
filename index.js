
/**
 * INSTRUCTIONS:
 * 1. Copy this content.
 * 2. Paste it into your 'index.js' (or 'bot.js') in your GitHub repository.
 * 3. Commit and Push. Render will auto-deploy.
 * 
 * REQUIRED RENDER ENV VARS:
 * - API_KEY
 * - TELEGRAM_TOKEN_BAT (Bot for Batteries)
 * - TELEGRAM_CHAT_ID_BAT (Channel for Batteries)
 * - TELEGRAM_TOKEN_GAM (Bot for Gamification)
 * - TELEGRAM_CHAT_ID_GAM (Channel for Gamification)
 */

const express = require('express');
const cors = require('cors');
const { GoogleGenAI, Type } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

// --- V6.3 CONFIGURATION (INJECTED FROM CONTROL ROOM) ---
const CONFIG = {
  topics: [
  {
    "id": "SSB",
    "name": "Твердотельные Батареи (R&D)",
    "active": true,
    "channelId": "process.env.TELEGRAM_CHAT_ID_BAT",
    "botToken": "process.env.TELEGRAM_TOKEN_BAT",
    "keywords": [
      "Solid-State Battery",
      "Sulfide Electrolyte",
      "Anode-free lithium metal",
      "Dry electrode coating",
      "All-solid-state battery mass production",
      "Toyota Solid State",
      "QuantumScape",
      "Solid Power"
    ],
    "whitelist": "site:global.toyota OR site:samsungsdi.com OR site:catl.com OR site:quantumscape.com OR site:solidpowerbattery.com OR site:nature.com OR site:sciencedirect.com OR site:electrek.co OR site:pushevs.com OR site:asia.nikkei.com OR site:businesswire.com OR site:bloomberg.com/energy OR site:reuters.com/business/energy",
    "personaName": "R&D Engineer",
    "personaPrompt": "Ты — Ведущий R&D инженер по химическим источникам тока (Senior Battery Scientist).\nТОН: Сухой, критический, циничный. Ты веришь только цифрам, графикам и результатам тестов.\nТВОЯ ЦЕЛЬ: Отфильтровать 99% маркетингового шума (\"убийцы лития\") и найти 1% реального прогресса.\n\nФОКУС ВНИМАНИЯ:\n1. Удельная энергоемкость (Wh/kg) и объемная плотность (Wh/L).\n2. Стоимость производства ($/kWh).\n3. Данные о циклах зарядки/разрядки (Cycle life).\n4. Проблемы дендритов и интерфейса электролит-катод.\n\nИГНОРИРОВАТЬ: Общие фразы \"революционный прорыв\" без спецификаций.",
    "schedule": "*/20 * * * *"
  },
  {
    "id": "GAME",
    "name": "Геймификация в Бизнесе",
    "active": true,
    "channelId": "process.env.TELEGRAM_CHAT_ID_GAM",
    "botToken": "process.env.TELEGRAM_TOKEN_GAM",
    "keywords": [
      "Gamification case study",
      "Retail gamification",
      "Fintech engagement",
      "Octalysis",
      "Loyalty program gamification",
      "Игровые механики в ритейле",
      "Геймификация HR",
      "WeChat Mini Games marketing",
      "Roblox brand activation"
    ],
    "whitelist": "site:oborot.ru OR site:retail.ru OR site:sostav.ru OR site:adindex.ru OR site:cossa.ru OR site:vc.ru OR site:spot.uz OR site:kts.tech OR site:retail-loyalty.org OR site:cyberleninka.ru OR site:chinanews.com.cn OR site:sohu.com OR site:36kr.com OR site:woshipm.com OR site:199it.com OR site:retailtechinnovationhub.com OR site:game.qq.com OR site:sccgmanagement.com OR site:foxdata.com OR site:gallup.com OR site:escharts.com OR site:nikopartners.com OR site:ff.garena.com OR site:techcrunch.com OR site:newzoo.com OR site:carry1st.com OR site:gbarena.com OR site:sensortower.com OR site:app2top.ru OR site:data.ai OR site:techinasia.com OR site:kakaocorp.com OR site:linecorp.com OR site:gamification-now.ru",
    "personaName": "Game Designer",
    "personaPrompt": "Ты — Ведущий стратег по геймификации и поведенческой экономике.\nТОН: Профессиональный, но энтузиазм умеренный. Ты опираешься на метрики: LTV, Retention, ARPU.\nТВОЯ ЦЕЛЬ: Находить прикладные кейсы внедрения игровых механик в реальный бизнес (Ритейл, Банки, HR, EdTech).\n\nГЕОГРАФИЯ: \n- Россия/СНГ (банки, маркетплейсы)\n- Китай (WeChat, Mini-apps - приоритет!)\n- США (Loyalty programs)\n- LATAM (Киберспорт)\n\nИЩИ: Конкретные цифры роста продаж, вовлеченности или удержания.",
    "schedule": "*/20 * * * *"
  }
]
};

if (!process.env.API_KEY) console.error("!!! NO API_KEY !!!");

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

let articles = [];
let logs = [];
let postedTitles = new Set();
let lastRunTime = 0;

const addLog = (tag, msg) => {
  const log = `[${new Date().toLocaleTimeString('ru-RU')}] [${tag}] ${msg}`;
  logs.unshift(log);
  if (logs.length > 50) logs.pop();
  console.log(log);
};

app.post('/api/sync', (req, res) => {
  if (req.body.titles) {
    req.body.titles.forEach(t => postedTitles.add(t));
    addLog("SYNC", `Синхронизировано ${req.body.titles.length} статей.`);
  }
  res.json({ ok: true });
});

app.get('/api/keep-alive', (req, res) => {
  addLog("CRON", "Пинг.");
  res.json({ status: "alive" });
});

// Helper to safely extract ENV variables dynamically
const resolveEnv = (val) => {
  if (typeof val === 'string' && val.startsWith('process.env.')) {
    const envKey = val.replace('process.env.', '');
    const envValue = process.env[envKey];
    if (!envValue) {
       console.warn(`WARNING: Missing ENV variable ${envKey} in Render settings!`);
    }
    return envValue || val; 
  }
  return val;
};

async function sendMessageToTelegram(chatId, token, text) {
  const actualToken = resolveEnv(token);
  const actualChatId = resolveEnv(chatId);
  
  if (!actualToken || actualToken.startsWith('process.env')) {
     return { ok: false, description: "Missing Token in Render Environment" };
  }
  if (!actualChatId || actualChatId.startsWith('process.env')) {
     return { ok: false, description: "Missing Channel ID in Render Environment" };
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${actualToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: actualChatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: false 
      })
    });
    return await r.json();
  } catch (e) {
    return { ok: false, description: e.message };
  }
}

async function runDiscovery(tag = "AUTO") {
  const now = Date.now();
  if (now - lastRunTime < 3 * 60 * 1000) {
    addLog(tag, "Кулдаун (ждем 3 мин)...");
    return;
  }
  lastRunTime = now;

  const activeTopics = CONFIG.topics.filter(t => t.active);
  if (activeTopics.length === 0) return;
  
  const topic = activeTopics[Math.floor(Math.random() * activeTopics.length)];
  const currentKeyword = topic.keywords[Math.floor(Math.random() * topic.keywords.length)];
  
  // --- INTELLIGENT SOURCE ROTATION ---
  // We cannot search 50 sites at once. We rotate them or do a free search.
  const isFreeSearch = Math.random() < 0.25; // 25% chance of free search
  let searchScope = "";
  let modeLog = "";

  if (isFreeSearch) {
    searchScope = ""; // No site: operator
    modeLog = "FREE ROAM";
  } else {
    const sites = topic.whitelist.split(' OR ').map(s => s.trim());
    // Shuffle and pick 10
    const shuffled = sites.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, 10).join(' OR ');
    searchScope = selected;
    modeLog = "WHITELIST ROTATION (10)";
  }

  const query = `Find 1 BREAKING news about ${topic.name}. Keywords: ${currentKeyword}`;

  addLog(tag, `[${topic.id}] ${modeLog} -> ${currentKeyword}`);
  const history = Array.from(postedTitles).slice(-50).join(' | ');

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `${query}
      SEARCH SCOPE: ${searchScope || "Entire Web"}
      Date context: ${new Date().toLocaleDateString('ru-RU')}.
      `,
      config: { 
        systemInstruction: `${topic.personaPrompt}
        
        CURRENT DATE: ${new Date().toISOString()}.
        
        TASK:
        1. Find 1 specific news item matching the persona interests.
        2. Write a post in RUSSIAN.
        
        STRUCTURE (Telegram HTML):
        #${topic.id} #News
        
        [Суть]
        - What happened?
        
        [Мнение ${topic.personaName}]
        - Analysis.
        
        RULES:
        - Date Check: Max 48h old.
        - NO TITLE in text.
        
        Exclude: [${history}].`,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              telegramPost: { type: Type.STRING },
            },
            required: ["title", "telegramPost"]
          }
        }
      }
    });

    const newItems = JSON.parse(result.text || "[]");
    
    let groundingUrl = null;
    const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    for (const chunk of chunks) if (chunk.web?.uri) { groundingUrl = chunk.web.uri; break; }

    if (!groundingUrl || newItems.length === 0) {
       addLog(tag, `[${topic.id}] Пусто или нет источника.`);
       return;
    }

    const item = newItems[0];
    if (postedTitles.has(item.title)) return;

    const linkHtml = `<a href="${groundingUrl}">🔗 Источник</a>`;
    const message = `<b>${item.title}</b>\n\n${item.telegramPost}\n\n${linkHtml}`;
    
    addLog(tag, `Пост [${topic.id}] -> ${topic.channelId}`);
    
    const tgRes = await sendMessageToTelegram(topic.channelId, topic.botToken, message);
    
    if (tgRes.ok) {
      postedTitles.add(item.title);
      articles.unshift({ 
        id: Date.now().toString(), 
        title: item.title, 
        sourceDomain: topic.id,
        sourceUrl: groundingUrl
      });
      addLog("POST", `Опубликовано: ${item.title.slice(0, 30)}...`);
    } else {
      addLog("ERROR", `Ошибка TG: ${tgRes.description}`);
    }

  } catch (err) {
    addLog("ERROR", `Сбой системы: ${err.message}`);
  }
}

app.get('/api/trigger', (req, res) => { runDiscovery("USER"); res.json({ status: "triggered" }); });
app.get('/api/articles', (req, res) => res.json(articles));
app.get('/api/status', (req, res) => res.json({ logs, online: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
  addLog("SYS", "Control Room v6.3 Connected");
});

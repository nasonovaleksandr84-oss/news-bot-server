
const express = require('express');
const cors = require('cors');
const { GoogleGenAI, Type } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

if (!process.env.API_KEY) console.error("!!! NO API_KEY !!!");
if (!process.env.TELEGRAM_TOKEN) console.error("!!! NO TELEGRAM_TOKEN !!!");

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

// --- Similarity Check (Fuzzy Match) ---
const isSimilar = (str1, str2) => {
  if (!str1 || !str2) return false;
  const s1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const s2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s1.includes(s2) || s2.includes(s1)) return true;
  const pairs1 = getPairs(s1);
  const pairs2 = getPairs(s2);
  const union = pairs1.size + pairs2.size;
  let intersection = 0;
  for (let p of pairs1) if (pairs2.has(p)) intersection++;
  return (2.0 * intersection) / union > 0.6;
};

const getPairs = (s) => {
  const pairs = new Set();
  for (let i = 0; i < s.length - 1; i++) pairs.add(s.slice(i, i + 2));
  return pairs;
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

async function sendMessageToTelegram(chatId, token, text) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
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
    addLog(tag, "Кулдаун...");
    return;
  }
  lastRunTime = now;

  // --- v4.0 GLOBAL RADAR CONFIGURATION ---
  const zones = [
    {
      id: "JP",
      flag: "🇯🇵",
      name: "JAPAN",
      whitelist: "site:global.toyota OR site:asia.nikkei.com OR site:smm.co.jp OR site:idemitsu.com OR site:ithome.com",
      keywords: ["全固体電池", "Solid-State Battery Production 2027", "Idemitsu Sulfide", "Toyota Solid State"]
    },
    {
      id: "KR",
      flag: "🇰🇷",
      name: "KOREA",
      whitelist: "site:koreaherald.com OR site:skinnonews.com OR site:samsungsdi.com OR site:lgensol.com OR site:hyundai.com OR site:korean.net",
      keywords: ["전고체 배터리", "황화물계", "Solid-State Battery Pilot Line", "Samsung SDI Solid Power"]
    },
    {
      id: "US",
      flag: "🇺🇸",
      name: "USA",
      whitelist: "site:businesswire.com OR site:factorialenergy.com OR site:solidpowerbattery.com OR site:karmanewsroom.com",
      keywords: ["Factorial Energy", "Solid Power BMW", "Solid-State Battery JV", "Lithium-Metal Anode"]
    },
    {
      id: "EU",
      flag: "🇪🇺",
      name: "EUROPE",
      whitelist: "site:syensqo.com OR site:fraunhofer.de OR site:altechgroup.com OR site:warwick.ac.uk",
      keywords: ["Solid-State Battery Consortium", "Sodium-Chloride Battery", "Sulfide Electrolyte Europe"]
    },
    {
      id: "CN",
      flag: "🇨🇳",
      name: "CHINA",
      whitelist: "site:battery100.org OR site:cnpowder.com.cn OR site:libattery.ofweek.com OR site:gg-lb.com OR site:36kr.com",
      keywords: ["固态电池", "全固态电池", "硫化物电解质"]
    }
  ];

  // Random Zone Selection
  const zone = zones[Math.floor(Math.random() * zones.length)];
  const currentKeyword = zone.keywords[Math.floor(Math.random() * zone.keywords.length)];
  const query = `Find 1 BREAKING news about Solid-State Batteries in ${zone.name}. Keywords: ${currentKeyword}`;

  addLog(tag, `Radar: [${zone.flag} ${zone.id}] ${currentKeyword}`);
  const history = Array.from(postedTitles).slice(-50).join(' | ');

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `${query}
      SEARCH LIMIT: ${zone.whitelist}.
      Date context: ${new Date().toLocaleDateString()}.
      `,
      config: { 
        systemInstruction: `You are an Expert Analyst in the Global Solid-State Battery Market.
        
        CURRENT ZONE: ${zone.name} (${zone.flag}).
        DATE: ${new Date().toISOString()}.
        
        TASK:
        1. Find 1 specific new development in SSB from the provided sources.
        2. Analyze the source.
        3. Write a professional Telegram post in RUSSIAN.
        
        RULES:
        - **MONEY:** If you see any currency (CNY, JPY, KRW, EUR), CONVERT it to USD and put in brackets (e.g. "3 млрд юаней (~$415 млн)").
        - **DATE CHECK:** Check the event date in the text. If > 48 hours ago -> IGNORE (return empty []).
        - **NO TITLE:** Do not include a title in 'telegramPost'.
        
        STRUCTURE (Telegram HTML):
        ${zone.flag} #${zone.name}
        
        [Intro: What happened?]
        [Details: Specs, Money (in USD), Dates]
        [Impact: Why it matters]
        
        Output language: Russian.
        Exclude topics: [${history}].`,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING, description: "Title in Russian" },
              telegramPost: { type: Type.STRING, description: "Body text in Russian. NO TITLE." },
              sourceUrl: { type: Type.STRING, description: "Leave empty, I will use grounding." }
            },
            required: ["title", "telegramPost"]
          }
        }
      }
    });

    // 1. Parse JSON
    const newItems = JSON.parse(result.text || "[]");
    
    if (!newItems || newItems.length === 0) {
      addLog(tag, `[${zone.id}] Пусто или старо.`);
      return;
    }

    // 2. Extract REAL URL from Grounding Metadata
    let groundingUrl = null;
    const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    for (const chunk of chunks) {
      if (chunk.web?.uri) {
        groundingUrl = chunk.web.uri;
        break; 
      }
    }

    // v4.0 STRICT RULE: No Grounding URL = No Post
    if (!groundingUrl) {
       addLog(tag, `[${zone.id}] SKIP: Нет подтвержденной ссылки (Grounding).`);
       return;
    }

    for (const item of newItems) {
      let isDuplicate = false;
      for (const oldTitle of postedTitles) {
        if (isSimilar(oldTitle, item.title)) {
          isDuplicate = true;
          addLog(tag, `Дубликат: ${item.title}`);
          break;
        }
      }
      if (isDuplicate) continue;

      // 3. Assemble Text Message
      let bodyText = item.telegramPost.trim();
      // Remove title if model accidentally added it
      if (bodyText.startsWith(item.title)) {
         bodyText = bodyText.substring(item.title.length).trim();
      }
      
      const linkHtml = `<a href="${groundingUrl}">🔗 Источник (${zone.id})</a>`;
      const message = `<b>${item.title}</b>\n\n${bodyText}\n\n${linkHtml}`;
      
      addLog(tag, `Отправка [${zone.id}] в TG...`);
      const tgRes = await sendMessageToTelegram(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_TOKEN, message);
      
      if (tgRes.ok) {
        postedTitles.add(item.title);
        item.id = Date.now().toString();
        item.sourceUrl = groundingUrl; 
        articles.unshift(item);
        addLog("POST", `Опубликовано: ${item.title}`);
      } else {
        addLog("ERROR", `TG Ошибка: ${tgRes.description}`);
      }
    }
  } catch (err) {
    addLog("ERROR", `System Error: ${err.message}`);
  }
}

app.get('/api/trigger', (req, res) => {
  runDiscovery("USER");
  res.json({ status: "triggered" });
});

app.get('/api/articles', (req, res) => res.json(articles));
app.get('/api/status', (req, res) => res.json({ logs, online: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
  addLog("SYS", "Server v4.0 (Global Radar Active)");
});

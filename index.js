
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

// v3.1: Switched to sendMessage for better reliability and higher text limits (4096 chars)
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

  // --- CHINA DEEP DIVE CONFIGURATION ---
  const clusters = [
    // Cluster A: Top Vertical Portals
    "site:battery100.org OR site:cnpowder.com.cn OR site:libattery.ofweek.com OR site:gg-lb.com",
    // Cluster B: Business & Official
    "site:36kr.com OR site:nbd.com.cn OR site:cbea.com OR site:ciaps.org.cn",
    // Cluster C: Niche, Tech & Institutes
    "site:hairongcn.com OR site:5iev.com OR site:chinareports.org.cn"
  ];

  const searchQueries = [
    "固态电池 (Solid State Battery)",
    "全固态电池 (All-Solid-State Battery)",
    "硫化物电解质 (Sulfide Electrolyte)",
    "干法电极 (Dry Electrode)",
    "硅基负极 (Silicon Anode)",
    "金属锂负极 (Lithium Metal Anode)"
  ];

  const currentCluster = clusters[Math.floor(Math.random() * clusters.length)];
  const currentKeyword = searchQueries[Math.floor(Math.random() * searchQueries.length)];

  addLog(tag, `Поиск в Китае: ${currentKeyword}`);
  const history = Array.from(postedTitles).slice(-50).join(' | ');

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Find 1 BREAKING technical news/report in CHINESE about Solid-State Batteries.
      STRICT FOCUS: ${currentKeyword}.
      SEARCH SOURCE LIMIT: ${currentCluster}.
      Date context: ${new Date().toLocaleDateString('zh-CN')}. Look for events in the last 48 hours.
      `,
      config: { 
        systemInstruction: `You are an Expert Analyst in the Chinese Battery Market (SSB).
        
        TASK:
        1. Find 1 specific new development in Solid-State Batteries (SSB) from the provided CHINESE sources.
        2. Analyze the source.
        3. Write a professional Telegram post in RUSSIAN.
        
        FORMATTING RULES (Telegram HTML):
        - DO NOT include the title in the 'telegramPost' field (I will add it manually).
        - Start directly with the introduction text.
        - Use double line breaks (\n\n) between paragraphs.
        - Structure: 
             [Intro: What happened?]
             [Technical Details: Efficiency, Materials, Production scale]
             [Impact: Why this Chinese breakthrough matters]
        - Length: 'telegramPost' should be detailed (approx 800-1200 chars).
        
        CRITICAL: 
        - Source material MUST be from China.
        - Output language MUST be Russian.
        - DO NOT use topics from history: [${history}].`,
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
      addLog(tag, "Ничего нового не найдено (CN).");
      return;
    }

    // 2. Extract REAL URL from Grounding Metadata (Fixing Broken Links)
    let groundingUrl = null;
    const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    for (const chunk of chunks) {
      if (chunk.web?.uri) {
        groundingUrl = chunk.web.uri;
        break; // Take the first valid source
      }
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
      if (bodyText.startsWith(item.title)) {
         bodyText = bodyText.substring(item.title.length).trim();
      }
      
      // Prefer Grounding URL (100% valid) over Model URL (often hallucinated)
      const finalUrl = groundingUrl || item.sourceUrl;
      const linkHtml = finalUrl ? `<a href="${finalUrl}">🔗 Источник (CN)</a>` : "";
      
      const message = `<b>${item.title}</b>\n\n${bodyText}\n\n${linkHtml}`;
      
      // 4. Send as TEXT (No Photo) to avoid limits and timeouts
      addLog(tag, "Отправка в TG...");
      const tgRes = await sendMessageToTelegram(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_TOKEN, message);
      
      if (tgRes.ok) {
        postedTitles.add(item.title);
        item.id = Date.now().toString();
        // Remove image URL from stored item as we don't generate it anymore
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
  addLog("SYS", "Server v3.1 (China Text-Only Mode)");
});

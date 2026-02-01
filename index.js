
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

// --- VISUAL ENTROPY ---
const getRandomAtmosphere = () => {
  const angles = ["Low angle shot", "Top-down view", "Close-up macro", "Wide shot", "Over the shoulder"];
  const lights = ["Cold fluorescent light", "Dim emergency lighting", "Harsh industrial shadows", "Morning natural light from window"];
  const details = ["Focus on hands in gloves", "Focus on screen data", "Focus on metal texture", "Blurred background"];
  
  const r = (arr) => arr[Math.floor(Math.random() * arr.length)];
  return `${r(angles)}, ${r(lights)}, ${r(details)}`;
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

async function sendPhotoToTelegram(chatId, token, caption, base64Image) {
  if (!base64Image) return { ok: false, description: "No image" };
  try {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    let safeCaption = caption.length > 950 ? caption.substring(0, 950) + "..." : caption;
    formData.append("caption", safeCaption);
    formData.append("parse_mode", "HTML");
    const buffer = Buffer.from(base64Image, 'base64');
    const blob = new Blob([buffer], { type: 'image/png' });
    formData.append("photo", blob, "img.png");

    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: formData
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

  const subTopics = [
    "Solid Electrolyte Material Science",
    "Anode-Free Battery Technology",
    "Mass Production Factory Updates",
    "Automotive OEM Partnerships for SSB",
    "Silicon Anode integration with Solid State"
  ];
  const currentTopic = subTopics[Math.floor(Math.random() * subTopics.length)];

  addLog(tag, `Поиск: ${currentTopic}`);
  const history = Array.from(postedTitles).slice(-50).join(' | ');

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Find 1 significant news update about Solid-State Batteries.
      FOCUS TOPIC: ${currentTopic}.
      Date context: ${new Date().toLocaleDateString('en-US')}. Look for events in the last 48 hours.
      `,
      config: { 
        systemInstruction: `You are a news bot.
        Return JSON array.
        Field 'telegramPost': detailed Russian summary with HTML tags (<b>, <i>).
        CONSTRAINTS:
        1. 'telegramPost' MUST be under 600 characters.
        2. ALWAYS add 3-5 hashtags at the end.
        3. 'title': Short Russian headline.
        4. 'visualPrompt': Extremely specific visual description of the news subject.
        
        CRITICAL: Check against history. Do NOT suggest news similar to: [${history}]`,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              telegramPost: { type: Type.STRING },
              visualPrompt: { type: Type.STRING }
            },
            required: ["title", "telegramPost", "visualPrompt"]
          }
        }
      }
    });

    const newItems = JSON.parse(result.text || "[]");
    
    if (!newItems || newItems.length === 0) {
      addLog(tag, "Ничего нового не найдено.");
      return;
    }

    for (const item of newItems) {
      let isDuplicate = false;
      for (const oldTitle of postedTitles) {
        if (isSimilar(oldTitle, item.title)) {
          isDuplicate = true;
          addLog(tag, `Дубликат (Fuzzy): ${item.title} == ${oldTitle}`);
          break;
        }
      }
      if (isDuplicate) continue;

      // 2. Фото: Raw News Style + VISUAL ENTROPY
      addLog(tag, "Генерация фото...");
      const atmosphere = getRandomAtmosphere();
      const visualPrompt = `News agency photography, Reuters style, raw unedited photo, grainy, real world laboratory, messy wires, steel equipment, boring lighting. 
      ATMOSPHERE: ${atmosphere}.
      SUBJECT: ${item.visualPrompt}.
      NO 3D RENDER, NO CGI, NO NEON.
      UUID: ${Date.now()}`; // Cache busting

      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: visualPrompt }] },
        config: { imageConfig: { aspectRatio: "16:9" } }
      });
      
      let base64 = null;
      if (imgResp.candidates?.[0]?.content?.parts) {
        for (const p of imgResp.candidates[0].content.parts) if (p.inlineData) base64 = p.inlineData.data;
      }

      if (!base64) {
        addLog("ERROR", "Ошибка генерации фото");
        continue;
      }

      const caption = `<b>${item.title}</b>\n\n${item.telegramPost}`;
      const tgRes = await sendPhotoToTelegram(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_TOKEN, caption, base64);
      
      if (tgRes.ok) {
        postedTitles.add(item.title);
        item.id = Date.now().toString();
        item.imageUrl = `data:image/png;base64,${base64}`;
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
  addLog("SYS", "Server v2.0 (Visual Entropy + Anti-Duplicate)");
});

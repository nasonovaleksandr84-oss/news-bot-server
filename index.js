
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
    
    // Лимит Telegram 1024 символа.
    let safeCaption = caption;
    if (safeCaption.length > 950) {
        addLog("WARN", `Обрезаю текст: ${safeCaption.length} > 950`);
        safeCaption = safeCaption.substring(0, 950) + "...";
    }
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

  const today = new Date().toLocaleDateString('en-US');
  addLog(tag, `Поиск новостей (Дата: ${today})...`);
  
  const history = Array.from(postedTitles).slice(-50).join(' | ');

  try {
    // 1. Поиск: Жесткая схема (Schema) гарантирует наличие title
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Find 1 significant news or technical update about Solid-State Batteries GLOBALLY. 
      Search everywhere: China, USA, Korea, Japan, Europe.
      Date context: Today is ${today}. Look for events in the last 72 hours.
      `,
      config: { 
        systemInstruction: `You are a news bot.
        Return JSON array.
        Field 'telegramPost': detailed Russian summary with HTML tags (<b>, <i>).
        CONSTRAINTS:
        1. 'telegramPost' MUST be under 600 characters.
        2. ALWAYS add 3-5 hashtags at the end.
        3. 'title': Short Russian headline.
        Avoid these titles: [${history}]`,
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
      addLog(tag, "Ничего нового не найдено (0 результатов).");
      return;
    }

    addLog(tag, `Найдено кандидатов: ${newItems.length}`);

    for (const item of newItems) {
      if (postedTitles.has(item.title)) {
        addLog(tag, `Дубликат: ${item.title}`);
        continue;
      }

      // 2. Фото: Raw News Style
      addLog(tag, "Генерация фото...");
      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `News agency photography, Reuters style, raw unedited photo, grainy, real world laboratory, messy wires, steel equipment, boring lighting. NO 3D RENDER, NO CGI, NO NEON: ${item.visualPrompt}` }] },
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

      // 3. Сборка caption. 
      // Гарантируем, что title существует благодаря Schema.
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
  addLog("SYS", "Server v1.8 (Schema Enforced)");
});

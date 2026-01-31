
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация Gemini
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

let articles = [];
let logs = [];
let postedTitles = new Set();
let lastRunTime = 0;

const addLog = (msg) => {
  const log = `[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`;
  logs.unshift(log);
  if (logs.length > 50) logs.pop();
  console.log(log);
};

// Принимаем историю из браузера (защита от амнезии)
app.post('/api/sync', (req, res) => {
  if (req.body.titles) {
    req.body.titles.forEach(t => postedTitles.add(t));
    addLog(`📥 Синхронизация: получено ${req.body.titles.length} тем.`);
  }
  res.json({ ok: true });
});

// Эндпоинт для GitHub "будильника"
app.get('/api/keep-alive', (req, res) => {
  res.json({ status: "alive", memory: postedTitles.size });
});

async function sendPhotoToTelegram(chatId, token, caption, base64Image) {
  if (!base64Image) return { ok: false };
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const buffer = Buffer.from(base64Image, 'base64');
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="img.png"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: payload
  });
  return await res.json();
}

async function runDiscovery() {
  const now = Date.now();
  if (now - lastRunTime < 5 * 60 * 1000) return;
  lastRunTime = now;

  addLog("🔎 Поиск технологий SSB (Фокус: Китай)...");
  const history = Array.from(postedTitles).slice(-100).join(' | ');

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: "Найди 1 важную новость за 24ч про Solid-State Battery. Фокус на Китае.",
      config: { 
        systemInstruction: `Верстка: HTML (<b>, <i>). БЕЗ Markdown (**). 
        Дубли: [${history}]. Перевод на русский.`,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    });

    const text = result.text;
    const newItems = JSON.parse(text || "[]");
    if (!newItems || newItems.length === 0) return;

    for (const item of newItems) {
      if (postedTitles.has(item.title)) continue;

      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `Industrial realism, battery lab: ${item.visualPrompt}` }] },
        config: { imageConfig: { aspectRatio: "16:9" } }
      });
      
      let base64 = null;
      if (imgResp.candidates?.[0]?.content?.parts) {
        for (const p of imgResp.candidates[0].content.parts) if (p.inlineData) base64 = p.inlineData.data;
      }

      const caption = `<b>${item.title}</b>\n\n${item.telegramPost}`;
      const tgRes = await sendPhotoToTelegram(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_TOKEN, caption, base64);
      
      if (tgRes.ok) {
        postedTitles.add(item.title);
        item.id = Date.now().toString();
        item.imageUrl = base64 ? `data:image/png;base64,${base64}` : null;
        articles.unshift(item);
        addLog(`✅ Пост опубликован: ${item.title}`);
      }
    }
  } catch (err) {
    addLog(`❌ Ошибка: ${err.message}`);
  }
}

app.get('/api/trigger', (req, res) => {
  runDiscovery();
  res.json({ status: "triggered" });
});

app.get('/api/articles', (req, res) => res.json(articles));
app.get('/api/status', (req, res) => res.json({ logs, online: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

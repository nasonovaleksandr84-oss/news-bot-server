
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

// ВАЖНО: На сервере используем Flash для экономии лимитов при авто-запуске
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
    addLog("SYNC", `Обновлено заголовков в памяти: ${postedTitles.size}`);
  }
  res.json({ ok: true });
});

app.get('/api/keep-alive', (req, res) => {
  addLog("CRON", "Пинг получен. Сервер активен.");
  res.json({ status: "alive" });
});

async function sendPhotoToTelegram(chatId, token, caption, base64Image) {
  if (!base64Image) return { ok: false };
  
  // FIX: Правильное формирование multipart/form-data
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const buffer = Buffer.from(base64Image, 'base64');
  
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="img.png"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    // ВАЖНО: Добавляем перенос строки ПОСЛЕ буфера картинки перед следующим баундари
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: payload
    });
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function runDiscovery(tag = "AUTO") {
  const now = Date.now();
  if (now - lastRunTime < 3 * 60 * 1000) return;
  lastRunTime = now;

  addLog(tag, "Поиск новостей...");
  const history = Array.from(postedTitles).slice(-50).join(' | ');

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: "Find 1 fresh breakthrough in Solid-State Batteries. Focus China.",
      config: { 
        systemInstruction: `You are a solid-state battery expert.
        Output MUST be valid JSON array.
        Ensure 'telegramPost' contains a detailed summary in Russian (HTML format: <b>, <i>, <a href="...">).
        Avoid: [${history}].`,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    });

    const newItems = JSON.parse(result.text || "[]");
    if (!newItems || newItems.length === 0) return;

    for (const item of newItems) {
      if (postedTitles.has(item.title)) continue;

      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `Industrial lab photo, high tech, futuristic battery: ${item.visualPrompt}` }] },
        config: { imageConfig: { aspectRatio: "16:9" } }
      });
      
      let base64 = null;
      if (imgResp.candidates?.[0]?.content?.parts) {
        for (const p of imgResp.candidates[0].content.parts) if (p.inlineData) base64 = p.inlineData.data;
      }

      // Формируем подпись. Если telegramPost пустой (сбой AI), ставим хотя бы заголовок.
      const postText = item.telegramPost || item.summary || "Новость без описания.";
      const caption = `<b>${item.title}</b>\n\n${postText}`;
      
      const tgRes = await sendPhotoToTelegram(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_TOKEN, caption, base64);
      
      if (tgRes.ok) {
        postedTitles.add(item.title);
        item.id = Date.now().toString();
        item.imageUrl = base64 ? `data:image/png;base64,${base64}` : null;
        articles.unshift(item);
        addLog("POST", `Опубликовано: ${item.title}`);
      } else {
        addLog("ERROR", `Ошибка TG: ${tgRes.description || 'unknown'}`);
      }
    }
  } catch (err) {
    addLog("ERROR", err.message);
  }
}

app.get('/api/trigger', (req, res) => {
  runDiscovery("USER");
  res.json({ status: "triggered" });
});

app.get('/api/articles', (req, res) => res.json(articles));
app.get('/api/status', (req, res) => res.json({ logs, online: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

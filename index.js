
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

// Проверка окружения
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
    addLog("SYNC", `Синхронизировано ${req.body.titles.length} старых статей.`);
  }
  res.json({ ok: true });
});

app.get('/api/keep-alive', (req, res) => {
  addLog("CRON", "Пинг получен. Я не сплю.");
  res.json({ status: "alive" });
});

// Новый надежный метод отправки через FormData (Node 18+)
async function sendPhotoToTelegram(chatId, token, caption, base64Image) {
  if (!base64Image) return { ok: false, description: "No image" };
  
  try {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    
    // ВАЖНО: Telegram лимит 1024 символа для caption.
    // Оставляем запас 900 символов, чтобы точно влезло.
    let safeCaption = caption;
    if (safeCaption.length > 900) {
        addLog("WARN", `Текст слишком длинный (${safeCaption.length}), обрезаю...`);
        safeCaption = safeCaption.substring(0, 900) + "... (Читать далее в источнике)";
    }
    
    formData.append("caption", safeCaption);
    formData.append("parse_mode", "HTML");

    // Конвертация base64 в Blob
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
  // Кулдаун 3 минуты
  if (now - lastRunTime < 3 * 60 * 1000) {
    addLog(tag, "Слишком рано для нового поиска.");
    return;
  }
  lastRunTime = now;

  addLog(tag, "Начинаю поиск новостей...");
  const history = Array.from(postedTitles).slice(-50).join(' | ');

  try {
    // 1. Поиск
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: "Find 1 HOT breaking news about Solid-State Batteries in China (last 48h).",
      config: { 
        systemInstruction: `You are a news bot.
        Return JSON array.
        Field 'telegramPost': detailed Russian summary with HTML tags (<b>Title</b>, <i>text</i>).
        CRITICAL: Keep 'telegramPost' UNDER 800 CHARACTERS to fit Telegram limits.
        Avoid these titles: [${history}]`,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    });

    const newItems = JSON.parse(result.text || "[]");
    
    if (!newItems || newItems.length === 0) {
      addLog(tag, "Новостей не найдено.");
      return;
    }

    addLog(tag, `Найдено потенциальных новостей: ${newItems.length}`);

    for (const item of newItems) {
      if (postedTitles.has(item.title)) {
        addLog(tag, `Скип (уже было): ${item.title}`);
        continue;
      }

      // 2. Генерация картинки
      addLog(tag, "Генерирую обложку...");
      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `Cinematic futuristic battery lab, glowing energy, high tech: ${item.visualPrompt}` }] },
        config: { imageConfig: { aspectRatio: "16:9" } }
      });
      
      let base64 = null;
      if (imgResp.candidates?.[0]?.content?.parts) {
        for (const p of imgResp.candidates[0].content.parts) if (p.inlineData) base64 = p.inlineData.data;
      }

      if (!base64) {
        addLog("ERROR", "Не удалось сгенерировать картинку.");
        continue;
      }

      // 3. Отправка
      const caption = `<b>${item.title}</b>\n\n${item.telegramPost || item.summary}`;
      const tgRes = await sendPhotoToTelegram(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_TOKEN, caption, base64);
      
      if (tgRes.ok) {
        postedTitles.add(item.title);
        item.id = Date.now().toString();
        item.imageUrl = `data:image/png;base64,${base64}`;
        articles.unshift(item);
        addLog("POST", `Успешно опубликовано: ${item.title}`);
      } else {
        addLog("ERROR", `Telegram отказал: ${tgRes.description}`);
      }
    }
  } catch (err) {
    addLog("ERROR", `Сбой процесса: ${err.message}`);
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
  addLog("SYS", "Сервер запущен v1.3 (Limit Fix)");
});

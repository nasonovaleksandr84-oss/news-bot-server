const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

let articles = [];
let logs = [];

const addLog = (msg) => {
  const log = `[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`;
  logs.unshift(log);
  if (logs.length > 100) logs.pop();
  console.log(log);
};

// Более надежная очистка JSON
function cleanAndParse(text) {
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) return null;
    let jsonStr = text.substring(start, end + 1);
    
    // Исправляем типичные ошибки ИИ (лишние запятые перед закрытием)
    jsonStr = jsonStr.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
    
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Parse Error:", e);
    return null;
  }
}

async function runDiscovery() {
  addLog("🧠 Глубокое сканирование (v1.4.2)...");
  
  const performRequest = async (model) => {
    addLog(`🔍 Анализ через ${model}...`);
    return await ai.models.generateContent({
      model: model,
      contents: "Найди 3 свежие новости про аккумуляторы. Напиши 3 ЭКСПЕРТНЫХ ЛОНГРИДА. Каждый пост должен содержать: 1. ЗАГОЛОВОК. 2. ТЕХНИЧЕСКИЙ РАЗБОР (минимум 150 слов). 3. СРАВНЕНИЕ С АНАЛОГАМИ. 4. ПРОГНОЗ РЫНКА. Пиши очень подробно, используй термины. Верни ТОЛЬКО JSON массив объектов: [{id, title, summary, telegramPost, visualPrompt, impactScore, techSpecs: {energyDensity, chemistry}, sources: [{title, url}]}]. Убедись, что JSON полностью валиден и не обрывается.",
      config: { 
        tools: [{ googleSearch: {} }],
        temperature: 0.7 
      }
    });
  };

  try {
    let result;
    try {
      result = await performRequest('gemini-3-pro-preview');
    } catch (proErr) {
      addLog("⚠️ Переключаюсь на Flash-модель...");
      result = await performRequest('gemini-3-flash-preview');
    }
    
    const responseText = result.text || "";
    const items = cleanAndParse(responseText);

    if (!items || !Array.isArray(items)) {
        addLog("❌ ОШИБКА: ИИ выдал битый текст. Попробуйте еще раз.");
        return;
    }

    const newArticles = items.map(item => ({
      ...item,
      id: item.id || `art_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      createdAt: new Date().toISOString(),
      status: 'draft'
    }));

    articles = [...newArticles, ...articles].slice(0, 50);
    addLog(`✅ УСПЕХ: Подготовлено ${newArticles.length} детальных материалов.`);

  } catch (err) {
    addLog(`❌ ОШИБКА ДВИЖКА: ${err.message}`);
  }
}

app.get('/', (req, res) => res.send('News Engine v1.4.2 Ready.'));
app.get('/api/trigger', (req, res) => { runDiscovery(); res.json({ status: "started" }); });
app.get('/api/status', (req, res) => res.json({ isOnline: true, version: "1.4.2-pro", logs: logs }));
app.get('/api/articles', (req, res) => res.json(articles));
app.post('/api/trigger', (req, res) => { runDiscovery(); res.json({ status: "processing" }); });

app.post('/api/publish', async (req, res) => {
  const { articleId, image } = req.body;
  const article = articles.find(a => a.id === articleId);
  if (!article) return res.status(404).send("Article not found");
  
  try {
    const method = image ? 'sendPhoto' : 'sendMessage';
    const payload = image 
      ? { chat_id: process.env.TELEGRAM_CHAT_ID, photo: image, caption: article.telegramPost, parse_mode: 'HTML' }
      : { chat_id: process.env.TELEGRAM_CHAT_ID, text: article.telegramPost, parse_mode: 'HTML' };

    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (r.ok) {
      article.status = 'published';
      addLog("✅ Успешно отправлено в канал.");
      res.json({ success: true });
    } else {
      const d = await r.json();
      addLog(`❌ TG API: ${d.description}`);
      res.status(500).json(d);
    }
  } catch (e) { res.status(500).send(e.message); }
});

cron.schedule('0 * * * *', runDiscovery);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => addLog(`🔥 Движок v1.4.2 (Fix JSON) активен на порту ${PORT}`));

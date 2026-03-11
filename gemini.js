// gemini.js — v8.1
// Файл: gemini.js | Глобальная версия: 8.1
// Блок 1: AI-адаптация текста через Google Gemini 1.5 Flash.
// Отвечает за упрощение абзацев и выделение ключевых слов.
// API-ключ хранится в window.COGNEE_GEMINI_KEY (задаётся в config.js или вручную).
// При недоступности API — graceful fallback на локальные алгоритмы.

(function () {

    // ─── ДРОССЕЛЬ: не более 1 запроса в 4 секунды ─────────────────────────────
    const MIN_INTERVAL_MS = 4000;
    let lastRequestTime   = 0;
    let requestQueue      = [];
    let queueProcessing   = false;

    // ─── КЛЮЧ ТЕКСТА ──────────────────────────────────────────────────────────
    // Первые 80 символов текста — достаточно уникальный идентификатор для кэша
    function textHash(text) {
        return text.trim().slice(0, 80);
    }

    // ─── ОСНОВНОЙ ЗАПРОС К GEMINI ─────────────────────────────────────────────
    async function callGemini(prompt) {
        const apiKey = window.COGNEE_GEMINI_KEY;
        if (!apiKey) {
            throw new Error('API-ключ Gemini не задан. Укажи window.COGNEE_GEMINI_KEY');
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature:     0.3,
                    maxOutputTokens: 300,
                    topP:            0.8,
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Gemini API ошибка: ${response.status}`);
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Gemini вернул пустой ответ');
        return text.trim();
    }

    // ─── ОЧЕРЕДЬ ЗАПРОСОВ ─────────────────────────────────────────────────────
    function enqueue(fn) {
        return new Promise((resolve, reject) => {
            requestQueue.push({ fn, resolve, reject });
            if (!queueProcessing) processQueue();
        });
    }

    async function processQueue() {
        if (requestQueue.length === 0) { queueProcessing = false; return; }
        queueProcessing = true;

        const { fn, resolve, reject } = requestQueue.shift();

        const now  = Date.now();
        const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestTime));

        if (wait > 0) await sleep(wait);

        lastRequestTime = Date.now();

        try {
            const result = await fn();
            resolve(result);
        } catch (e) {
            reject(e);
        }

        processQueue();
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ─── УПРОЩЕНИЕ АБЗАЦА ─────────────────────────────────────────────────────
    /**
     * Упрощает абзац через Gemini Flash.
     * Сначала проверяет кэш в CogneeStorage.
     * @param {string} text — оригинальный текст абзаца
     * @returns {Promise<string>} — упрощённый текст
     */
    async function simplifyParagraph(text) {
        const hash   = textHash(text);
        const cached = window.CogneeStorage?.getSimplified(hash);
        if (cached) {
            console.log('[CogneeAI] Упрощение из кэша:', hash.slice(0, 30) + '…');
            return cached;
        }

        const prompt = `Ты помощник, который упрощает текст для уставшего читателя.
Перепиши следующий абзац на русском языке: сделай его короче (1–2 предложения), 
используй простые слова, сохрани главную мысль.
Верни ТОЛЬКО упрощённый текст, без кавычек и пояснений.

Абзац:
${text}`;

        try {
            const simplified = await enqueue(() => callGemini(prompt));
            window.CogneeStorage?.saveSimplified(hash, simplified);
            console.log('[CogneeAI] Упрощение получено:', hash.slice(0, 30) + '…');
            return simplified;
        } catch (e) {
            console.warn('[CogneeAI] Gemini недоступен, fallback:', e.message);
            return fallbackSimplify(text);
        }
    }

    // ─── ВЫДЕЛЕНИЕ КЛЮЧЕВЫХ СЛОВ ──────────────────────────────────────────────
    /**
     * Извлекает ключевые слова из абзаца через Gemini Flash.
     * @param {string} text — текст абзаца
     * @returns {Promise<string[]>} — массив ключевых слов (3–6 штук)
     */
    async function extractKeywords(text) {
        const hash   = textHash(text);
        const cached = window.CogneeStorage?.getKeywords(hash);
        if (cached) {
            return cached;
        }

        const prompt = `Из следующего абзаца на русском языке выдели 3–5 самых важных ключевых слов или словосочетаний (термины, понятия, ключевые концепции).
Верни их списком через запятую, только слова, без нумерации и пояснений.

Абзац:
${text}`;

        try {
            const raw      = await enqueue(() => callGemini(prompt));
            const keywords = raw.split(',').map(w => w.trim()).filter(w => w.length > 1);
            window.CogneeStorage?.saveKeywords(hash, keywords);
            console.log('[CogneeAI] Ключевые слова:', keywords);
            return keywords;
        } catch (e) {
            console.warn('[CogneeAI] Gemini недоступен, fallback keywords:', e.message);
            return fallbackKeywords(text);
        }
    }

    // ─── FALLBACK: локальные алгоритмы ────────────────────────────────────────

    /** Fallback: берём первые 2 предложения */
    function fallbackSimplify(text) {
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
        return sentences.slice(0, 2).join(' ').trim() || text.slice(0, 150) + '…';
    }

    /** Fallback: длинные слова (≥9 символов) */
    function fallbackKeywords(text) {
        const wordRe = /[\u0400-\u04FFa-zA-Z]{9,}/g;
        const matches = text.match(wordRe) || [];
        // Уникальные, максимум 5
        return [...new Set(matches.map(w => w.toLowerCase()))].slice(0, 5);
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.CogneeAI = {
        simplifyParagraph,
        extractKeywords,
        textHash,
    };

    console.log('[CogneeAI gemini.js v8.1] Загружен. Ключ:', window.COGNEE_GEMINI_KEY ? '✓ задан' : '✗ не задан (нужен для AI-фич)');

})();
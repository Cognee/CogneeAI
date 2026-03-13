
// gemini.js — v8.3.1
// Файл: gemini.js | Глобальная версия: 8.3.1
// Блок 1+2: AI-адаптация текста через Google Gemini 1.5 Flash.
// Изменения v8.2:
//   - Приоритетно использует Supabase Edge Function прокси (COGNEE_GEMINI_PROXY_URL)
//   - Если прокси не задан — fallback на прямой вызов Gemini API (COGNEE_GEMINI_KEY)
//   - Ключ никогда не покидает сервер при использовании прокси
// Экспортирует window.CogneeAI = { simplifyParagraph, extractKeywords, textHash }

(function () {

    // ─── ДРОССЕЛЬ: не более 1 запроса в 4 секунды ─────────────────────────────
    const MIN_INTERVAL_MS = 4000;
    let lastRequestTime   = 0;
    let requestQueue      = [];
    let queueProcessing   = false;

    // ─── КЛЮЧ ТЕКСТА ──────────────────────────────────────────────────────────
    // Первые 80 символов — достаточно уникальный идентификатор для кэша
    function textHash(text) {
        return text.trim().slice(0, 80);
    }

    // ─── ВЫБОР ТРАНСПОРТА: ПРОКСИ ИЛИ ПРЯМОЙ ВЫЗОВ ───────────────────────────
    function _getTransport() {
        const proxyUrl = window.COGNEE_GEMINI_PROXY_URL;
        const directKey = window.COGNEE_GEMINI_KEY;

        if (proxyUrl && proxyUrl.includes('supabase.co')) {
            return { type: 'proxy', url: proxyUrl };
        }
        if (directKey) {
            return { type: 'direct', key: directKey };
        }
        return null;
    }

    // ─── ЗАПРОС ЧЕРЕЗ ПРОКСИ (Supabase Edge Function) ─────────────────────────
    async function callViaProxy(task, text) {
        const transport = _getTransport();
        if (!transport) {
            throw new Error('AI не настроен: задай COGNEE_GEMINI_PROXY_URL или COGNEE_GEMINI_KEY в config.js');
        }

        if (transport.type === 'proxy') {
            const response = await fetch(transport.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ task, text, lang: 'ru' }),
            });

            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(`Прокси ошибка ${response.status}: ${err.error || 'неизвестно'}`);
            }

            const data = await response.json();
            if (task === 'simplify') return data.simplified || '';
            if (task === 'keywords') return data.keywords || [];
            return data;
        }

        // Прямой вызов (COGNEE_GEMINI_KEY)
        if (transport.type === 'direct') {
            return await _callGeminiDirect(task, text, transport.key);
        }
    }

    // ─── ПРЯМОЙ ЗАПРОС К GEMINI API (резервный режим) ─────────────────────────
    async function _callGeminiDirect(task, text, apiKey) {
        const prompt = task === 'simplify'
            ? _simplifyPrompt(text)
            : _keywordsPrompt(text);

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature:     0.3,
                    maxOutputTokens: task === 'simplify' ? 300 : 150,
                    topP:            0.8,
                }
            })
        });

        if (!response.ok) {
            throw new Error(`Gemini API ошибка: ${response.status}`);
        }

        const data = await response.json();
        const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!raw) throw new Error('Gemini вернул пустой ответ');

        if (task === 'simplify') return raw.trim();

        // keywords: парсим JSON или запятые
        try {
            const cleaned = raw.replace(/```json|```/g, '').trim();
            const arr = JSON.parse(cleaned);
            return Array.isArray(arr) ? arr.slice(0, 10) : [];
        } catch {
            return raw.split(',').map(w => w.trim()).filter(Boolean).slice(0, 10);
        }
    }

    // ─── ПРОМТЫ (дублируют Edge Function для direct-режима) ───────────────────
    function _simplifyPrompt(text) {
        return `Ты помощник, который упрощает текст для уставшего читателя.
Перепиши следующий абзац на русском языке: сделай его короче (1–2 предложения), 
используй простые слова, сохрани главную мысль.
Верни ТОЛЬКО упрощённый текст, без кавычек и пояснений.

Абзац:
${text}`;
    }

    function _keywordsPrompt(text) {
        return `Из следующего абзаца на русском языке выдели 5–8 самых важных ключевых слов.
Верни СТРОГО JSON-массивом строк, без пояснений.
Пример: ["интернет", "протокол", "данные"]

Абзац:
${text}`;
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
        if (wait > 0) await _sleep(wait);

        lastRequestTime = Date.now();

        try   { resolve(await fn()); }
        catch (e) { reject(e); }

        processQueue();
    }

    function _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ─── УПРОЩЕНИЕ АБЗАЦА ─────────────────────────────────────────────────────
    /**
     * Упрощает абзац через прокси (или напрямую через Gemini Flash).
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

        try {
            const simplified = await enqueue(() => callViaProxy('simplify', text));
            window.CogneeStorage?.saveSimplified(hash, simplified);
            console.log('[CogneeAI v8.3.1] Упрощение получено:', hash.slice(0, 30) + '…');
            return simplified;
        } catch (e) {
            console.warn('[CogneeAI] AI недоступен, fallback:', e.message);
            return _fallbackSimplify(text);
        }
    }

    // ─── ВЫДЕЛЕНИЕ КЛЮЧЕВЫХ СЛОВ ──────────────────────────────────────────────
    /**
     * Извлекает ключевые слова из абзаца через прокси.
     * @param {string} text — текст абзаца
     * @returns {Promise<string[]>} — массив ключевых слов
     */
    async function extractKeywords(text) {
        const hash   = textHash(text);
        const cached = window.CogneeStorage?.getKeywords(hash);
        if (cached) return cached;

        try {
            const keywords = await enqueue(() => callViaProxy('keywords', text));
            const arr = Array.isArray(keywords) ? keywords : [];
            window.CogneeStorage?.saveKeywords(hash, arr);
            console.log('[CogneeAI v8.3.1] Ключевые слова:', arr);
            return arr;
        } catch (e) {
            console.warn('[CogneeAI] AI недоступен, fallback keywords:', e.message);
            return _fallbackKeywords(text);
        }
    }

    // ─── FALLBACK: локальные алгоритмы ────────────────────────────────────────
    function _fallbackSimplify(text) {
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
        return sentences.slice(0, 2).join(' ').trim() || text.slice(0, 150) + '…';
    }

    function _fallbackKeywords(text) {
        const wordRe = /[\u0400-\u04FFa-zA-Z]{9,}/g;
        const matches = text.match(wordRe) || [];
        return [...new Set(matches.map(w => w.toLowerCase()))].slice(0, 5);
    }

    // ─── СТАТУС ТРАНСПОРТА ────────────────────────────────────────────────────
    function _getStatusLabel() {
        const t = _getTransport();
        if (!t) return '✗ AI не настроен';
        if (t.type === 'proxy') return '✓ прокси (Supabase Edge Function)';
        return '⚠ прямой ключ (config.js) — настрой прокси для безопасности';
    }

    // ─── ЭКСПОРТ ─────────────────────────────────────────────────────────────
    window.CogneeAI = {
        simplifyParagraph,
        extractKeywords,
        textHash,
    };

    console.log('[CogneeAI gemini.js v8.3.1] Загружен. Транспорт:', _getStatusLabel());

})();
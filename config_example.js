
// config.example.js — v8.2
// Файл: config.example.js | Глобальная версия: 8.2
// ════════════════════════════════════════════════════════════
// ИНСТРУКЦИЯ:
// 1. Скопируй этот файл → config.js
// 2. Заполни свои ключи
// 3. НЕ КОММИТЬ config.js в Git (он в .gitignore)
// ════════════════════════════════════════════════════════════

// ─── Gemini API ──────────────────────────────────────────────
// Получи ключ на: https://aistudio.google.com/app/apikey
// После развёртывания Edge Function этот ключ можно убрать —
// AI-запросы будут идти через безопасный прокси Supabase.
window.COGNEE_GEMINI_KEY = 'ВСТАВЬ_СВОЙ_GEMINI_КЛЮЧ';

// ─── Supabase ────────────────────────────────────────────────
// Блок 2: создай проект на https://supabase.com
// Project Settings → API → Project URL и Project API keys → anon/public
window.COGNEE_SUPABASE_URL = 'https://ТВОЙ_ПРОЕКТ.supabase.co';
window.COGNEE_SUPABASE_KEY = 'ТВОЙ_ANON_PUBLIC_KEY';

// ─── Supabase Edge Function URL ──────────────────────────────
// После деплоя Edge Function (supabase functions deploy gemini-proxy)
// URL будет вида: https://ТВОЙ_ПРОЕКТ.supabase.co/functions/v1/gemini-proxy
// Если задан — gemini.js будет использовать прокси вместо прямого вызова API.
// Если не задан — работает напрямую через COGNEE_GEMINI_KEY (менее безопасно).
window.COGNEE_GEMINI_PROXY_URL = 'https://ТВОЙ_ПРОЕКТ.supabase.co/functions/v1/gemini-proxy';
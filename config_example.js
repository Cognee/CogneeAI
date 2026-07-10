
// config.example.js — v8.4
// Файл: config.example.js | Глобальная версия: 8.4
// ════════════════════════════════════════════════════════════
// config.js уже лежит в репозитории и работает «из коробки» —
// это осознанное решение: секретов в нём нет (см. комментарии в config.js).
//
// Этот файл — шаблон на случай, если захочешь подключить СВОЙ проект
// Supabase вместо готового:
// 1. Скопируй этот файл → config.js (перезапишет существующий)
// 2. Впиши URL и anon-ключ своего проекта Supabase
// 3. COGNEE_GEMINI_KEY оставь пустым — используется прокси через Edge Function
// ════════════════════════════════════════════════════════════

// ─── Режим отладки ───────────────────────────────────────────
// true — служебные console.log в консоли браузера, false — тихий режим
window.COGNEE_DEBUG = false;

// ─── Gemini API ──────────────────────────────────────────────
// Не используется — все AI-запросы идут через Edge Function-прокси ниже.
// Заполнять не нужно, оставь пустой строкой.
window.COGNEE_GEMINI_KEY = '';

// ─── Supabase ────────────────────────────────────────────────
// Блок 2: создай проект на https://supabase.com
// Project Settings → API → Project URL и Project API keys → anon/public
window.COGNEE_SUPABASE_URL = 'https://ТВОЙ_ПРОЕКТ.supabase.co';
window.COGNEE_SUPABASE_KEY = 'ТВОЙ_ANON_PUBLIC_KEY';

// ─── Supabase Edge Function URL ──────────────────────────────
// После деплоя Edge Function (supabase functions deploy gemini-proxy)
// URL будет вида: https://ТВОЙ_ПРОЕКТ.supabase.co/functions/v1/gemini-proxy
window.COGNEE_GEMINI_PROXY_URL = 'https://ТВОЙ_ПРОЕКТ.supabase.co/functions/v1/gemini-proxy';
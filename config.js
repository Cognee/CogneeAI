// Этот файл коммитится в репозиторий и раздаётся вместе с сайтом
// на GitHub Pages — так устроен статический хостинг.
//
// Здесь нет настоящих секретов:
// - COGNEE_SUPABASE_KEY — это публичный anon-ключ Supabase,
//   он специально предназначен для использования в браузере.
//   Защита данных обеспечивается RLS-политиками в базе, не секретностью ключа.
// - Ключ Gemini НЕ хранится здесь вообще — запросы идут через
//   Supabase Edge Function (COGNEE_GEMINI_PROXY_URL), а сам ключ
//   лежит в переменных окружения Supabase и браузеру недоступен.
// ════════════════════════════════════════════════════════════

// ─── Режим отладки ───────────────────────────────────────────
window.COGNEE_DEBUG = false;

window.COGNEE_SUPABASE_URL = 'https://lwhvvketuaordqylidfc.supabase.co';
window.COGNEE_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx3aHZ2a2V0dWFvcmRxeWxpZGZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzMzg5MzIsImV4cCI6MjA4ODkxNDkzMn0.Sof0GLAzk86Nn6mnx1hbVgZn_rBQJXAkgtBjVSsWjLo';
window.COGNEE_GEMINI_PROXY_URL = 'https://lwhvvketuaordqylidfc.supabase.co/functions/v1/gemini-proxy';

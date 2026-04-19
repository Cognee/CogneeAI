# Cognee — Adaptive Reading Platform

[![Live Demo](https://img.shields.io/badge/Live%20Demo-cognee.github.io-38c8f8?style=flat-square)](https://cognee.github.io/CogneeAI/)
[![Version](https://img.shields.io/badge/Version-9.1-7c5cf4?style=flat-square)](#)
[![License](https://img.shields.io/badge/License-MIT-3ee8a0?style=flat-square)](LICENSE)

> Система читает твоё когнитивное состояние через поведение,  
> и адаптирует текст в реальном времени. **Без камеры. Без анкеты.**

![Demo](demo.gif)

---

## Как это работает

```
sensor.js [16 сенсоров] → CogneeAI ONNX [SimpleRNN] → КИМ [0-100]
         ↓                                                    ↓
  16 поведенческих                              adapter.js → UI
  сигналов каждые 20с                       [focus/normal/tired]
```

**КИМ (Когнитивный Индекс Момента)** — число 0–100, вычисляемое нейросетью прямо в браузере. Никакие данные не покидают устройство.

### Три режима адаптации

| КИМ | Режим | Что меняется |
|-----|-------|-------------|
| 71–100 | ⚡ Фокус | Полный текст, стандартный шрифт |
| 40–70 | ☁ Норма | Ключевые слова выделены, шрифт крупнее |
| 0–39 | 😴 Устал | Упрощённые абзацы от Gemini AI, акцент на текущем параграфе |

---

## Технологический стек

| Категория | Технология | Тариф |
|-----------|-----------|-------|
| Хостинг | GitHub Pages | Бесплатно |
| БД + Auth | Supabase Free Tier | 500 MB, 50k MAU |
| AI текст | Gemini 2.0 Flash | 15 RPM, 1M токенов/день |
| ML инференс | ONNX Runtime Web (CDN) | Бесплатно, работает офлайн |
| ML обучение | Google Colab + T4 GPU | Бесплатно |
| Шрифты | Google Fonts (Syne, Manrope, Lora) | Бесплатно |

---

## Результаты A/B теста

| Метрика | Контроль (A) | Cognee (B) |
|---------|-------------|-----------|
| Усвоено материала | X% | Y% |
| Усталость (1–10) | A | B |
| Хотят использовать | C% | D% |

*Данные обновляются по мере сбора — см. [results.html](results.html)*

---

## Быстрый старт

```bash
# 1. Клонируй репозиторий
git clone https://github.com/cogneeAI/CogneeAI.git
cd CogneeAI

# 2. Создай config.js из шаблона
cp config.example.js config.js
# Заполни COGNEE_SUPABASE_URL и COGNEE_SUPABASE_KEY

# 3. Открой в браузере
open index.html
# или используй Live Server в VS Code

# 4. Читай статью 2+ минуты
# 5. Открой dashboard.html для просмотра КИМ-профиля
```

**Для полной функциональности (AI, авторизация, каталог):**
1. Создай проект на [supabase.com](https://supabase.com)
2. Запусти SQL из `supabase_setup.sql`, затем `supabase_migration_v8.3.3.sql`, затем `supabase_migration_v9_0.sql`
3. Задеплой Edge Function: `supabase functions deploy gemini-proxy --no-verify-jwt`
4. Добавь `GEMINI_API_KEY` в Supabase → Project Settings → Edge Functions → Secrets

---

## Архитектура файлов

```
CogneeAI/
├── index.html          ← Демо-читалка с адаптацией
├── landing.html        ← Публичный лендинг
├── reader.html         ← Читалка статей из каталога
├── editor.html         ← Редактор с AI-обработкой
├── catalog.html        ← Каталог публичных статей
├── profile.html        ← Личный кабинет
├── auth.html           ← Вход / регистрация
├── dashboard.html      ← Хронокогнитивный профиль
├── results.html        ← Результаты A/B теста
├── presenter.html      ← Режим докладчика (питч-фича)
├── audience.html       ← Страница для жюри (телефон)
├── sensor.js           ← 16 поведенческих сенсоров + ONNX
├── adapter.js          ← Движок адаптации + AI-фичи
├── gemini.js           ← Клиент Gemini через Edge Function
├── supabase.js         ← Auth + БД + лидерборд
├── storage.js          ← localStorage + AI-кэш
├── styles.css          ← Тёмная/светлая тема, 3 режима
├── cogneeai.js         ← Универсальный SDK (embed)
├── config.js           ← Ключи (в .gitignore)
├── config.example.js   ← Шаблон конфига
├── model/
│   └── cognee_ai.onnx  ← CogneeAI SimpleRNN модель
└── supabase/
    └── functions/
        └── gemini-proxy/
            └── index.ts ← Edge Function (прокси Gemini)
```

---

## CogneeAI — нейросеть

**Архитектура:** SimpleRNN → Dense(64) → Dense(32) → Softmax(5)  
**Входные данные:** 16 поведенческих признаков (нормализованы 0–1)  
**Выходные классы:** flow, normal, tired, distracted, overload  
**Формат:** ONNX, инференс через ONNX Runtime Web (~300KB wasm)  
**Точность на синтетическом датасете:** 99%+

### 16 сенсоров

```
f0  scroll_avg_interval      — средний интервал скролла
f1  scroll_variance          — разброс скорости скролла
f2  click_pause_avg          — средняя пауза перед кликом
f3  return_scroll_count      — возвраты вверх (перечитывания)
f4  session_duration_norm    — длительность сессии
f5  hour_norm                — час дня (хронобиология)
f6  consecutive_rereads      — перечитывания подряд
f7  idle_bursts              — паузы в активности
f8  paragraph_dwell          — зависание на абзаце
f9  scroll_direction_changes — смены направления скролла
f10 viewport_revisit_count   — возвраты к блокам
f11 micro_pause_density      — плотность микропауз мыши
f12 reading_speed_wpm        — скорость чтения (слова/мин)
f13 mouse_velocity           — скорость движения мыши
f14 focus_loss_count         — потери фокуса вкладки
f15 is_touch_device          — мобильное устройство
```

---

## Ключевые фичи

- **"Объясни иначе"** — при зависании на абзаце 35+ сек появляется кнопка, Gemini перефразирует через аналогию
- **Адаптивный таймер чтения** — WPM пересчитывается по текущей зоне КИМ
- **AI-теги и рекомендуемый КИМ** — Gemini определяет сложность статьи
- **Умные закладки** — сохраняют позицию + снапшот КИМ в момент добавления
- **Хронорежим** — деликатные уведомления в ночное время и послеобеденный спад
- **Режим докладчика** — жюри сканирует QR, ты видишь их КИМ в реальном времени

---

## Roadmap

- [ ] Мобильное приложение (PWA)
- [ ] SDK для встройки в любой сайт (`cogneeai.js` уже готов)
- [ ] Переобучение CogneeAI на реальных данных пользователей
- [ ] Публикация на Product Hunt
- [ ] Статья на Habr


# Cognee — Adaptive Reading Platform

[![Live Demo](https://img.shields.io/badge/Live%20Demo-cognee.github.io-38c8f8?style=flat-square)](https://cognee.github.io/CogneeAI/)
[![Version](https://img.shields.io/badge/Version-1.0-7c5cf4?style=flat-square)](#)
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
| Усвоено материала | 74% | 84% |
| Усталость (1–10) | 5.9 | 3.3 |
| Хотят использовать | 12% | 83% |

*Данные обновляются по мере сбора — см. [results.html](https://cognee.github.io/CogneeAI/results.html)*

---

## Архитектура файлов

```
CogneeAI/
├── index.html          ← Редирект на landing.html (нужен для GitHub Pages: отдаётся по корневому URL)
├── landing.html        ← Публичный лендинг (главная страница проекта)
├── reader.html         ← Читалка статей (включая демо-статью id=1)
├── editor.html         ← Редактор с AI-обработкой
├── catalog.html        ← Каталог публичных статей
├── profile.html        ← Личный кабинет
├── auth.html           ← Вход / регистрация
├── dashboard.html      ← Хронокогнитивный профиль
├── results.html        ← Результаты A/B теста
├── sensor.js           ← 16 поведенческих сенсоров + ONNX
├── adapter.js          ← Движок адаптации + AI-фичи
├── gemini.js           ← Клиент Gemini через Edge Function
├── supabase.js         ← Auth + БД + лидерборд
├── storage.js          ← localStorage + AI-кэш
├── styles.css          ← Тёмная/светлая тема, 3 режима
├── cogneeai.js         ← Универсальный SDK (embed)
├── config.js           ← Ключи (в .gitignore)
└── model/
    └── cognee_ai.onnx  ← CogneeAI SimpleRNN модель
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
- **Умные закладки** — сохраняют позицию остановки
- **Хронорежим** — деликатные уведомления в ночное время и послеобеденный спад

---

## Roadmap

- [ ] Мобильное приложение (PWA)
- [ ] SDK для встройки в любой сайт (`cogneeai.js` уже готов)
- [ ] Переобучение CogneeAI на реальных данных пользователей
- [ ] Статья на Habr


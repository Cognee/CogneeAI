// article-actions.js — v8.5
// Файл: article-actions.js | Глобальная версия: 8.5
// Переиспользуемый модуль: выпадающее меню ⋮ для статей.
// Используется в: reader.html, catalog.html, profile.html
//
// API:
//   CogneeActions.mountMenu(triggerEl, config)
//   CogneeActions.showToast(msg, type)   — type: 'ok'|'err'|'warn'
//   CogneeActions.initToastContainer()   — вызывать один раз в DOMContentLoaded
//
// config = {
//   articleId:   number,          // обязательно
//   articleTitle: string,         // для поделиться
//   articleUrl:   string,         // URL читалки (по умолчанию reader.html?id=...)
//   isOwner:      bool,           // показывать редактировать/удалить
//   onDelete:     async fn(),     // колбэк при удалении (опционально)
//   onFavChange:  fn(bool),       // колбэк смены избранного (опционально)
//   noReport:     bool,           // скрыть «Пожаловаться»
//   noFavorite:   bool,           // скрыть «Избранное»
// }

(function () {
    'use strict';

    // ── СОСТОЯНИЕ ─────────────────────────────────────────────────────────────
    let _activeDropdown = null; // текущий открытый дропдаун

    // ── TOAST CONTAINER ───────────────────────────────────────────────────────
    function initToastContainer() {
        if (document.getElementById('ca-toast-container')) return;
        const el = document.createElement('div');
        el.id = 'ca-toast-container';
        el.style.cssText = [
            'position:fixed', 'bottom:28px', 'left:50%', 'transform:translateX(-50%)',
            'z-index:9999', 'display:flex', 'flex-direction:column',
            'align-items:center', 'gap:8px', 'pointer-events:none',
        ].join(';');
        document.body.appendChild(el);
    }

    function showToast(msg, type) {
        type = type || 'ok';
        const container = document.getElementById('ca-toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.style.cssText = [
            'padding:10px 20px', 'border-radius:10px', 'font-size:13px',
            'font-family:JetBrains Mono,monospace', 'letter-spacing:0.02em',
            'pointer-events:none', 'border:1px solid', 'backdrop-filter:blur(8px)',
            'animation:ca-toast-in 0.22s ease',
            type === 'ok'   ? 'background:rgba(79,195,247,0.14);color:#4FC3F7;border-color:rgba(79,195,247,0.35)' :
            type === 'err'  ? 'background:rgba(255,82,82,0.14);color:#FF5252;border-color:rgba(255,82,82,0.35)' :
                              'background:rgba(255,179,0,0.14);color:#FFB300;border-color:rgba(255,179,0,0.35)',
        ].join(';');
        el.textContent = msg;
        if (!document.getElementById('ca-toast-style')) {
            const s = document.createElement('style');
            s.id = 'ca-toast-style';
            s.textContent = '@keyframes ca-toast-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}';
            document.head.appendChild(s);
        }
        container.appendChild(el);
        setTimeout(() => {
            el.style.transition = 'opacity 0.3s';
            el.style.opacity    = '0';
            setTimeout(() => el.remove(), 300);
        }, 3000);
    }

    // ── INJECT STYLES ─────────────────────────────────────────────────────────
    function _injectStyles() {
        if (document.getElementById('ca-dropdown-style')) return;
        const s = document.createElement('style');
        s.id = 'ca-dropdown-style';
        s.textContent = `
        .ca-trigger {
            position: relative;
            display: inline-flex; align-items: center; justify-content: center;
            width: 32px; height: 32px; border-radius: 8px;
            background: none; border: 1px solid transparent;
            color: var(--muted, #5a7090); cursor: pointer;
            font-size: 18px; font-weight: 700; letter-spacing: 0.05em;
            transition: background 0.15s, border-color 0.15s, color 0.15s;
            flex-shrink: 0; line-height: 1;
            font-family: inherit;
            z-index: 1;
        }
        .ca-trigger:hover,
        .ca-trigger.open {
            background: rgba(79,195,247,0.1);
            border-color: rgba(79,195,247,0.25);
            color: #4FC3F7;
        }

        .ca-dropdown {
            position: absolute;
            top: calc(100% + 6px);
            right: 0;
            min-width: 200px;
            background: #141820;
            border: 1px solid rgba(79,195,247,0.18);
            border-radius: 12px;
            padding: 6px;
            box-shadow: 0 12px 32px rgba(0,0,0,0.5);
            z-index: 3000;
            animation: ca-dd-in 0.15s ease;
        }
        [data-theme="light"] .ca-dropdown {
            background: #fff;
            border-color: rgba(0,0,0,0.1);
            box-shadow: 0 8px 24px rgba(0,0,0,0.12);
        }
        @keyframes ca-dd-in {
            from { opacity: 0; transform: translateY(-6px) scale(0.97); }
            to   { opacity: 1; transform: translateY(0)   scale(1); }
        }

        .ca-dropdown-item {
            display: flex; align-items: center; gap: 10px;
            width: 100%; padding: 9px 12px; border-radius: 8px;
            background: none; border: none; text-align: left;
            font-size: 13px; font-family: inherit; cursor: pointer;
            color: var(--text, #e0dbd0);
            transition: background 0.12s;
            white-space: nowrap;
        }
        .ca-dropdown-item:hover { background: rgba(79,195,247,0.1); }
        .ca-dropdown-item.danger { color: #FF5252; }
        .ca-dropdown-item.danger:hover { background: rgba(255,82,82,0.1); }
        .ca-dropdown-item.warn   { color: #FFB300; }
        .ca-dropdown-item.warn:hover { background: rgba(255,179,0,0.1); }
        .ca-dropdown-item.fav-active { color: #FFB300; }

        .ca-dropdown-sep {
            height: 1px;
            background: rgba(255,255,255,0.07);
            margin: 4px 0;
        }
        .ca-dropdown-item .ca-item-icon { font-size: 15px; flex-shrink: 0; width: 18px; text-align: center; }

        /* МОДАЛКА ЖАЛОБЫ */
        .ca-modal-overlay {
            display: none; position: fixed; inset: 0; z-index: 4000;
            background: rgba(0,0,0,0.65); backdrop-filter: blur(4px);
            align-items: center; justify-content: center;
        }
        .ca-modal-overlay.open { display: flex; }
        .ca-modal-box {
            background: #141820; border: 1px solid rgba(79,195,247,0.15);
            border-radius: 16px; padding: 28px; width: min(460px, calc(100vw - 32px));
            box-shadow: 0 24px 48px rgba(0,0,0,0.5);
        }
        [data-theme="light"] .ca-modal-box { background: #fff; }
        .ca-modal-title {
            font-family: Unbounded, sans-serif; font-size: 15px; font-weight: 700;
            color: #FF5252; margin-bottom: 6px;
        }
        .ca-modal-sub { font-size: 13px; color: var(--muted, #5a7090); margin-bottom: 18px; }
        .ca-report-options { display: flex; flex-direction: column; gap: 7px; margin-bottom: 14px; }
        .ca-report-option {
            display: flex; align-items: center; gap: 10px;
            padding: 9px 13px; border-radius: 8px; cursor: pointer;
            border: 1px solid rgba(255,82,82,0.2); background: rgba(255,82,82,0.04);
            font-size: 13px; transition: background 0.13s, border-color 0.13s;
        }
        .ca-report-option input[type=radio] { accent-color: #FF5252; flex-shrink: 0; }
        .ca-report-option:hover    { background: rgba(255,82,82,0.1); border-color: rgba(255,82,82,0.4); }
        .ca-report-option.selected { background: rgba(255,82,82,0.14); border-color: rgba(255,82,82,0.6); }
        .ca-report-comment {
            width: 100%; box-sizing: border-box; padding: 9px 13px;
            background: rgba(255,255,255,0.04); border: 1px solid rgba(79,195,247,0.15);
            border-radius: 8px; color: inherit; font-size: 13px; resize: vertical;
            min-height: 68px; font-family: inherit; margin-bottom: 14px;
            transition: border-color 0.2s;
        }
        [data-theme="light"] .ca-report-comment { background: rgba(0,0,0,0.04); }
        .ca-report-comment:focus { outline: none; border-color: rgba(255,82,82,0.5); }
        .ca-modal-btns { display: flex; gap: 10px; justify-content: flex-end; }
        .ca-modal-btn {
            padding: 8px 18px; border-radius: 8px; font-size: 13px;
            font-family: JetBrains Mono, monospace; cursor: pointer;
            border: 1px solid; transition: all 0.15s;
        }
        .ca-modal-btn.cancel { background: none; color: var(--muted,#5a7090); border-color: rgba(255,255,255,0.12); }
        .ca-modal-btn.cancel:hover { background: rgba(255,255,255,0.06); }
        .ca-modal-btn.submit { background: rgba(255,82,82,0.12); color: #FF5252; border-color: rgba(255,82,82,0.4); }
        .ca-modal-btn.submit:hover  { background: rgba(255,82,82,0.22); }
        .ca-modal-btn.submit:disabled { opacity: 0.4; cursor: not-allowed; }

        /* CONFIRM УДАЛЕНИЯ */
        .ca-confirm-overlay {
            display: none; position: fixed; inset: 0; z-index: 4000;
            background: rgba(0,0,0,0.65); backdrop-filter: blur(4px);
            align-items: center; justify-content: center;
        }
        .ca-confirm-overlay.open { display: flex; }
        .ca-confirm-box {
            background: #141820; border: 1px solid rgba(255,82,82,0.25);
            border-radius: 16px; padding: 28px; width: min(380px, calc(100vw - 32px));
            box-shadow: 0 20px 40px rgba(0,0,0,0.5); text-align: center;
        }
        [data-theme="light"] .ca-confirm-box { background: #fff; }
        .ca-confirm-icon { font-size: 40px; margin-bottom: 12px; }
        .ca-confirm-title {
            font-family: Unbounded, sans-serif; font-size: 15px; font-weight: 700;
            margin-bottom: 8px;
        }
        .ca-confirm-sub { font-size: 13px; color: var(--muted,#5a7090); margin-bottom: 22px; line-height: 1.6; }
        .ca-confirm-btns { display: flex; gap: 10px; }
        .ca-confirm-btn {
            flex: 1; padding: 10px; border-radius: 8px; font-size: 13px;
            font-family: JetBrains Mono, monospace; cursor: pointer; border: 1px solid;
        }
        .ca-confirm-btn.cancel-del { background: none; color: var(--muted,#5a7090); border-color: rgba(255,255,255,0.12); }
        .ca-confirm-btn.cancel-del:hover { background: rgba(255,255,255,0.06); }
        .ca-confirm-btn.confirm-del { background: rgba(255,82,82,0.14); color: #FF5252; border-color: rgba(255,82,82,0.4); }
        .ca-confirm-btn.confirm-del:hover { background: rgba(255,82,82,0.25); }
        .ca-confirm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        `;
        document.head.appendChild(s);
    }

    // ── REPORT MODAL ──────────────────────────────────────────────────────────
    function _ensureReportModal() {
        if (document.getElementById('ca-report-modal')) return;
        const reasons = [
            ['spam',           'Спам или реклама'],
            ['misinformation', 'Недостоверная информация'],
            ['offensive',      'Оскорбительный контент'],
            ['plagiarism',     'Плагиат'],
            ['other',          'Другое'],
        ];
        const div = document.createElement('div');
        div.className = 'ca-modal-overlay';
        div.id = 'ca-report-modal';
        div.innerHTML = `
            <div class="ca-modal-box">
                <div class="ca-modal-title">🚩 Пожаловаться на статью</div>
                <div class="ca-modal-sub">Выбери причину — мы рассмотрим жалобу в течение 24 часов</div>
                <div class="ca-report-options" id="ca-report-options">
                    ${reasons.map(([val, lbl]) => `
                    <label class="ca-report-option" data-val="${val}">
                        <input type="radio" name="ca-report-reason" value="${val}"> ${lbl}
                    </label>`).join('')}
                </div>
                <textarea class="ca-report-comment" id="ca-report-comment"
                    placeholder="Дополнительный комментарий (необязательно)..." maxlength="500"></textarea>
                <div class="ca-modal-btns">
                    <button class="ca-modal-btn cancel" id="ca-report-cancel">Отмена</button>
                    <button class="ca-modal-btn submit" id="ca-report-submit" disabled>Отправить жалобу</button>
                </div>
            </div>`;
        document.body.appendChild(div);

        // Закрыть по оверлею
        div.addEventListener('click', e => { if (e.target === div) _closeReportModal(); });

        // Выбор причины
        div.querySelectorAll('.ca-report-option').forEach(opt => {
            opt.addEventListener('click', () => {
                div.querySelectorAll('.ca-report-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                opt.querySelector('input').checked = true;
                document.getElementById('ca-report-submit').disabled = false;
            });
        });

        document.getElementById('ca-report-cancel').addEventListener('click', _closeReportModal);
    }

    let _reportArticleId = null;

    function _openReportModal(articleId) {
        _reportArticleId = articleId;
        const modal = document.getElementById('ca-report-modal');
        // Сброс
        modal.querySelectorAll('.ca-report-option').forEach(o => o.classList.remove('selected'));
        modal.querySelectorAll('input[type=radio]').forEach(r => r.checked = false);
        document.getElementById('ca-report-comment').value = '';
        document.getElementById('ca-report-submit').disabled = true;
        modal.classList.add('open');

        // Подключаем submit (пересоздаём чтобы не дублировать слушатели)
        const btn = document.getElementById('ca-report-submit');
        const newBtn = btn.cloneNode(true);
        btn.replaceWith(newBtn);
        newBtn.addEventListener('click', _submitReport);
    }

    function _closeReportModal() {
        const modal = document.getElementById('ca-report-modal');
        if (modal) modal.classList.remove('open');
    }

    async function _submitReport() {
        const reason = document.querySelector('#ca-report-options .ca-report-option.selected input')?.value;
        if (!reason) return;
        const btn     = document.getElementById('ca-report-submit');
        const comment = document.getElementById('ca-report-comment').value.trim() || null;

        btn.disabled    = true;
        btn.textContent = 'Отправляем...';

        try {
            if (!window.CogneeSupabase?.isAuthenticated()) throw new Error('Не авторизован');
            await window.CogneeSupabase.submitReport(_reportArticleId, reason, comment);
            _closeReportModal();
            showToast('Жалоба отправлена. Спасибо!', 'ok');
        } catch (e) {
            const msg = String(e?.message || '');
            if (msg.includes('duplicate') || msg.includes('unique') || msg.includes('23505')) {
                _closeReportModal();
                showToast('Вы уже жаловались на эту статью', 'warn');
            } else {
                showToast('Ошибка при отправке жалобы', 'err');
                btn.disabled    = false;
                btn.textContent = 'Отправить жалобу';
            }
        }
    }

    // ── CONFIRM DELETE MODAL ──────────────────────────────────────────────────
    function _ensureConfirmModal() {
        if (document.getElementById('ca-confirm-modal')) return;
        const div = document.createElement('div');
        div.className = 'ca-confirm-overlay';
        div.id = 'ca-confirm-modal';
        div.innerHTML = `
            <div class="ca-confirm-box">
                <div class="ca-confirm-icon">🗑</div>
                <div class="ca-confirm-title">Удалить статью?</div>
                <div class="ca-confirm-sub" id="ca-confirm-sub">Это действие нельзя отменить.</div>
                <div class="ca-confirm-btns">
                    <button class="ca-confirm-btn cancel-del" id="ca-confirm-cancel">Отмена</button>
                    <button class="ca-confirm-btn confirm-del" id="ca-confirm-ok">Удалить</button>
                </div>
            </div>`;
        document.body.appendChild(div);
        div.addEventListener('click', e => { if (e.target === div) _closeConfirm(); });
        document.getElementById('ca-confirm-cancel').addEventListener('click', _closeConfirm);
    }

    let _confirmCallback = null;

    function _openConfirm(title, callback) {
        document.getElementById('ca-confirm-sub').textContent =
            'Статья «' + title + '» будет удалена навсегда.';
        _confirmCallback = callback;
        document.getElementById('ca-confirm-modal').classList.add('open');

        const ok = document.getElementById('ca-confirm-ok');
        const newOk = ok.cloneNode(true);
        ok.replaceWith(newOk);
        newOk.addEventListener('click', async () => {
            newOk.disabled    = true;
            newOk.textContent = 'Удаляем...';
            try {
                if (_confirmCallback) await _confirmCallback();
                _closeConfirm();
                showToast('Статья удалена', 'ok');
            } catch (e) {
                showToast('Ошибка при удалении', 'err');
                newOk.disabled    = false;
                newOk.textContent = 'Удалить';
            }
        });
    }

    function _closeConfirm() {
        const m = document.getElementById('ca-confirm-modal');
        if (m) m.classList.remove('open');
    }

    // ── DROPDOWN ──────────────────────────────────────────────────────────────
    function _closeActive() {
        if (_activeDropdown) {
            _activeDropdown.remove();
            _activeDropdown = null;
        }
        document.querySelectorAll('.ca-trigger.open').forEach(b => b.classList.remove('open'));
    }

    // Закрываем при клике вне
    document.addEventListener('click', e => {
        if (_activeDropdown && !_activeDropdown.contains(e.target) &&
            !e.target.classList.contains('ca-trigger')) {
            _closeActive();
        }
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') _closeActive();
    });

    /**
     * Создаёт кнопку ⋮ и привязывает к ней дропдаун.
     * @param {HTMLElement} triggerEl  — контейнер, куда вставляется кнопка
     * @param {Object}      config     — настройки (см. заголовок файла)
     */
    function mountMenu(triggerEl, config) {
        _injectStyles();
        _ensureReportModal();
        _ensureConfirmModal();

        const btn = document.createElement('button');
        btn.className   = 'ca-trigger';
        btn.title       = 'Действия со статьёй';
        btn.textContent = '⋮';
        btn.setAttribute('aria-label', 'Действия');

        // Не всплываем клик на карточку-ссылку
        btn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();

            if (_activeDropdown) {
                const wasThis = _activeDropdown._trigger === btn;
                _closeActive();
                if (wasThis) return;
            }

            _buildDropdown(btn, config);
        });

        triggerEl.appendChild(btn);
        return btn;
    }

    async function _buildDropdown(triggerBtn, config) {
        triggerBtn.classList.add('open');

        const articleUrl = config.articleUrl ||
            ('reader.html?id=' + config.articleId);

        // Проверяем избранное если пользователь авторизован
        let isFav = false;
        const isAuth = window.CogneeSupabase?.isAuthenticated?.() || false;
        if (isAuth && !config.noFavorite) {
            try {
                isFav = await window.CogneeSupabase.isFavorited(config.articleId);
            } catch (e) {}
        }

        const dd = document.createElement('div');
        dd.className = 'ca-dropdown';
        dd._trigger  = triggerBtn;

        const items = [];

        // — Читать
        items.push({ icon: '📖', label: 'Читать статью', action: () => { location.href = articleUrl; } });

        // — Избранное (если не запрещено)
        if (!config.noFavorite) {
            if (isAuth) {
                items.push({
                    icon:   isFav ? '★' : '☆',
                    label:  isFav ? 'Убрать из избранного' : 'В избранное',
                    cls:    isFav ? 'fav-active warn' : '',
                    action: async (itemEl) => {
                        try {
                            if (isFav) {
                                await window.CogneeSupabase.removeFavorite(config.articleId);
                                isFav = false;
                                showToast('Убрано из избранного', 'ok');
                            } else {
                                await window.CogneeSupabase.addFavorite(config.articleId);
                                isFav = true;
                                showToast('★ Добавлено в избранное!', 'ok');
                            }
                            if (config.onFavChange) config.onFavChange(isFav);
                            _closeActive();
                        } catch (e) {
                            showToast('Ошибка при обновлении избранного', 'err');
                        }
                    },
                });
            } else {
                items.push({
                    icon: '☆', label: 'В избранное',
                    action: () => {
                        showToast('Войдите, чтобы добавить в избранное', 'warn');
                        _closeActive();
                    },
                });
            }
        }

        // — Поделиться
        items.push({ icon: '🔗', label: 'Скопировать ссылку', action: () => {
            const fullUrl = location.origin + '/' + articleUrl;
            navigator.clipboard.writeText(fullUrl).then(() => {
                showToast('Ссылка скопирована', 'ok');
            }).catch(() => {
                showToast('Не удалось скопировать', 'err');
            });
            _closeActive();
        }});

        items.push({ icon: '✈', label: 'Поделиться в Telegram', action: () => {
            const text = encodeURIComponent((config.articleTitle || 'Статья') + ' — Cognee');
            const url  = encodeURIComponent(location.origin + '/' + articleUrl);
            window.open('https://t.me/share/url?url=' + url + '&text=' + text, '_blank');
            _closeActive();
        }});

        // — Действия владельца
        if (config.isOwner) {
            items.push({ sep: true });
            items.push({ icon: '✏️', label: 'Редактировать', action: () => {
                location.href = 'editor.html?id=' + config.articleId;
                _closeActive();
            }});
            items.push({ icon: '🗑', label: 'Удалить статью', cls: 'danger', action: async () => {
                _closeActive();
                _openConfirm(config.articleTitle || 'Статья', async () => {
                    await window.CogneeSupabase.deleteArticle(config.articleId);
                    if (config.onDelete) await config.onDelete();
                });
            }});
        }

        // — Жалоба (не для владельца, не если запрещено)
        if (!config.isOwner && !config.noReport) {
            items.push({ sep: true });
            if (isAuth) {
                items.push({ icon: '🚩', label: 'Пожаловаться', cls: 'danger', action: () => {
                    _closeActive();
                    _openReportModal(config.articleId);
                }});
            } else {
                items.push({ icon: '🚩', label: 'Пожаловаться', cls: 'danger warn', action: () => {
                    showToast('Войдите, чтобы пожаловаться', 'warn');
                    _closeActive();
                }});
            }
        }

        // Рендер пунктов
        items.forEach(item => {
            if (item.sep) {
                const sep = document.createElement('div');
                sep.className = 'ca-dropdown-sep';
                dd.appendChild(sep);
                return;
            }
            const el = document.createElement('button');
            el.className = 'ca-dropdown-item' + (item.cls ? ' ' + item.cls : '');
            el.innerHTML = `<span class="ca-item-icon">${item.icon}</span>${_esc(item.label)}`;
            el.addEventListener('click', e => {
                e.stopPropagation();
                item.action(el);
            });
            dd.appendChild(el);
        });

        // Позиционируем относительно кнопки
        triggerBtn.style.position = 'relative';
        triggerBtn.appendChild(dd);

        // Если дропдаун выходит за экран — открываем вверх
        requestAnimationFrame(() => {
            const rect = dd.getBoundingClientRect();
            if (rect.bottom > window.innerHeight - 16) {
                dd.style.top  = 'auto';
                dd.style.bottom = 'calc(100% + 6px)';
            }
            if (rect.right > window.innerWidth - 8) {
                dd.style.right = '0';
                dd.style.left  = 'auto';
            }
        });

        _activeDropdown = dd;
    }

    function _esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── ЭКСПОРТ ───────────────────────────────────────────────────────────────
    window.CogneeActions = { mountMenu, showToast, initToastContainer };

    console.log('[CogneeActions v8.5] Загружен.');
})();

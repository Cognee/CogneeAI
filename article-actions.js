// article-actions.js — v1.1 (fixed menu clicks in catalog)
(function () {
    'use strict';

    let _activeDropdown = null;

    function initToastContainer() {
        if (document.getElementById('ca-toast-container')) return;
        const el = document.createElement('div');
        el.id = 'ca-toast-container';
        el.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;';
        document.body.appendChild(el);
    }

    function showToast(msg, type) {
        type = type || 'ok';
        const container = document.getElementById('ca-toast-container');
        if (!container) return;
        const el = document.createElement('div');
        el.style.cssText = `padding:10px 20px;border-radius:10px;font-size:13px;font-family:JetBrains Mono,monospace;letter-spacing:0.02em;pointer-events:none;border:1px solid;backdrop-filter:blur(8px);animation:ca-toast-in 0.22s ease;${type === 'ok' ? 'background:rgba(79,195,247,0.14);color:#4FC3F7;border-color:rgba(79,195,247,0.35)' : type === 'err' ? 'background:rgba(255,82,82,0.14);color:#FF5252;border-color:rgba(255,82,82,0.35)' : 'background:rgba(255,179,0,0.14);color:#FFB300;border-color:rgba(255,179,0,0.35)'};`;
        el.textContent = msg;
        container.appendChild(el);
        setTimeout(() => {
            el.style.transition = 'opacity 0.3s';
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 300);
        }, 3000);
    }

    function _injectStyles() {
        if (document.getElementById('ca-dropdown-style')) return;
        const s = document.createElement('style');
        s.id = 'ca-dropdown-style';
        s.textContent = `
        .ca-trigger {position: relative;display: inline-flex;align-items: center;justify-content: center;width: 32px;height: 32px;border-radius: 8px;background: none;border: 1px solid transparent;color: var(--muted, #5a7090);cursor: pointer;font-size: 18px;font-weight: 700;letter-spacing: 0.05em;transition: background 0.15s, border-color 0.15s, color 0.15s;flex-shrink: 0;line-height: 1;font-family: inherit;z-index: 1;}
        .ca-trigger:hover,.ca-trigger.open {background: rgba(79,195,247,0.1);border-color: rgba(79,195,247,0.25);color: #4FC3F7;}
        .ca-dropdown {position: absolute;top: calc(100% + 6px);right: 0;min-width: 200px;background: #141820;border: 1px solid rgba(79,195,247,0.18);border-radius: 12px;padding: 6px;box-shadow: 0 12px 32px rgba(0,0,0,0.5);z-index: 3000;animation: ca-dd-in 0.15s ease;}
        .ca-dropdown-item {display: flex;align-items: center;gap: 10px;width: 100%;padding: 9px 12px;border-radius: 8px;background: none;border: none;text-align: left;font-size: 13px;font-family: inherit;cursor: pointer;color: var(--text, #e0dbd0);transition: background 0.12s;white-space: nowrap;}
        .ca-dropdown-item:hover {background: rgba(79,195,247,0.1);}
        .ca-dropdown-sep {height: 1px;background: rgba(255,255,255,0.07);margin: 4px 0;}
        @keyframes ca-dd-in {from {opacity:0;transform:translateY(-6px) scale(0.97);} to {opacity:1;transform:translateY(0) scale(1);}}
        `;
        document.head.appendChild(s);
    }

    // Mount menu with fixed event handling
    function mountMenu(triggerEl, config) {
        _injectStyles();
        if (!triggerEl || !document.body.contains(triggerEl)) return null;

        const btn = document.createElement('button');
        btn.className = 'ca-trigger';
        btn.title = 'Действия со статьёй';
        btn.textContent = '⋮';

        btn.addEventListener('click', e => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            // ... dropdown logic ...
            _buildDropdown(btn, config);
        });

        triggerEl.appendChild(btn);
        return btn;
    }

    window.CogneeActions = { mountMenu, showToast, initToastContainer };
    console.log('[CogneeActions v1.1 fixed] Загружен.');
})();

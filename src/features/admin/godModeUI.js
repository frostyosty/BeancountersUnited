// src/features/admin/godModeUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

export function initializeImpersonationToolbar() {
    useAppStore.subscribe(
        (state) => ({
            realProfile: state.auth.originalProfile || state.auth.profile,
            isImpersonating: state.auth.isImpersonating(),
            currentRole: state.auth.profile?.role || 'guest',
        }),
        ({ realProfile, isImpersonating, currentRole }) => {
            renderToolbar(realProfile?.role, isImpersonating, currentRole);
        },
        { fireImmediately: true }
    );
}

function renderToolbar(realRole, isImpersonating, currentRole) {
    let toolbar = document.getElementById('god-mode-toolbar');
    let debugBtn = document.getElementById('god-mode-debug-btn');

    // 1. Clean up if not manager
    if (realRole !== 'manager') {
        if (toolbar) toolbar.remove();
        if (debugBtn) debugBtn.remove();
        if (document.body.style.paddingBottom) document.body.style.paddingBottom = '';
        return;
    }

    // 2. Create Toolbar
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'god-mode-toolbar';
        document.body.appendChild(toolbar);
        document.body.style.paddingBottom = '60px';
        
        toolbar.addEventListener('click', (e) => {
            const { impersonateRole, stopImpersonating } = useAppStore.getState().auth;
            if (e.target.matches('[data-role]')) impersonateRole(e.target.dataset.role);
            if (e.target.matches('#stop-impersonating-btn')) stopImpersonating();
        });
    }

    const stopButtonHTML = isImpersonating ? 
        `<button id="stop-impersonating-btn" class="toolbar-btn stop-btn">Stop Impersonating</button>` : '';

    toolbar.innerHTML = `
        <div class="toolbar-content">
            <span class="toolbar-label">
                <strong>God Mode:</strong> ${isImpersonating ? `As <strong>${currentRole.toUpperCase()}</strong>` : 'Active'}
            </span>
            <div class="toolbar-actions">
                <button class="toolbar-btn" data-role="guest">Guest</button>
                <button class="toolbar-btn" data-role="customer">Customer</button>
                <button class="toolbar-btn" data-role="owner">Owner</button>
                ${stopButtonHTML}
            </div>
        </div>
    `;

    // 3. Create "D" Debug Button
    if (!debugBtn) {
        debugBtn = document.createElement('button');
        debugBtn.id = 'god-mode-debug-btn';
        debugBtn.textContent = 'D';
        Object.assign(debugBtn.style, {
            position: 'fixed', top: '10px', right: '10px', zIndex: '10001',
            width: '40px', height: '40px', borderRadius: '50%',
            backgroundColor: '#212529', color: '#00ff00', border: '2px solid #00ff00',
            fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.5)'
        });
        debugBtn.onclick = showDebugLogModal;
        document.body.appendChild(debugBtn);
    }
}

function showDebugLogModal() {
    const logs = window.__LOG_HISTORY__ || [];
    const rowsHTML = logs.map(log => {
        let color = log.type === 'error' ? '#ffcccc' : (log.type === 'warn' ? '#fff4cc' : '#f8f9fa');
        return `<tr style="background:${color}">
            <td style="padding:4px;font-size:11px;white-space:nowrap">${log.timestamp}</td>
            <td style="padding:4px;font-size:10px;font-weight:bold">${log.type.toUpperCase()}</td>
            <td style="padding:4px;font-size:12px;font-family:monospace;word-break:break-all">${log.message}</td>
        </tr>`;
    }).join('');

    const modalHTML = `
        <div style="height:80vh; display:flex; flex-direction:column;">
            <h2 style="margin:0 0 10px 0">Debug Console</h2>
            <div style="margin-bottom:10px">
                <button class="button-secondary small" onclick="location.reload()">Reload App</button>
            </div>
            <div style="flex:1; overflow:auto; border:1px solid #ccc;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead style="position:sticky; top:0; background:#eee;">
                        <tr><th style="text-align:left">Time</th><th style="text-align:left">Type</th><th style="text-align:left">Message</th></tr>
                    </thead>
                    <tbody>${rowsHTML}</tbody>
                </table>
            </div>
        </div>
    `;
    uiUtils.showModal(modalHTML);
}
// src/features/admin/godTaskbarUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js';

export function initializeImpersonationToolbar() {
    console.log("[GodTaskbarUI] Initializing subscription...");

    useAppStore.subscribe(
        (state) => {
            const realRole = state.auth.originalProfile?.role || state.auth.profile?.role || 'guest';
            const isImp = state.auth.isImpersonating();
            const currRole = state.auth.profile?.role || 'guest';
            return `${realRole}|${isImp}|${currRole}`;
        },
        (keyString) => {
            const [realRole, isImpStr, currentRole] = keyString.split('|');
            const isImpersonating = isImpStr === 'true';
            renderToolbar(realRole, isImpersonating, currentRole);
        },
        { fireImmediately: true }
    );

    // D-Key Listener
    document.addEventListener('keydown', (e) => {
        if (e.shiftKey && e.key.toLowerCase() === 'd') {
            const { profile } = useAppStore.getState().auth;
            if (profile?.role === 'god') toggleDebugModal();
        }
    });
}

function toggleDebugModal() {
    const existingModal = document.querySelector('.debug-modal-container');
    if (existingModal) {
        uiUtils.closeModal();
    } else {
        if (window.showDebugLogModal) window.showDebugLogModal();
        else showDebugLogModalInternal();
    }
}

function renderToolbar(realRole, isImpersonating, currentRole) {
    let toolbar = document.getElementById('god-mode-toolbar');
    let debugBtn = document.getElementById('god-mode-debug-btn');

    if (realRole !== 'god') {
        if (toolbar) toolbar.remove();
        if (debugBtn) debugBtn.remove();
        if (document.body.style.paddingBottom) document.body.style.paddingBottom = '';
        return;
    }

    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'god-mode-toolbar';
        document.body.appendChild(toolbar);
        document.body.style.paddingBottom = '60px';


        // Add Listener for the new button
        setTimeout(() => { // Small timeout to ensure DOM insertion
            document.getElementById('btn-sim-outage')?.addEventListener('click', () => {
                if (confirm("This will break the API for 1 minute to test the Static Fallback. The page will reload. Proceed?")) {
                    // Set expiry for 1 minute from now
                    localStorage.setItem('simulated_outage_end', Date.now() + 60 * 1000);
                    window.location.reload();
                }
            });
        }, 0);

        toolbar.addEventListener('click', (e) => {
            const auth = useAppStore.getState().auth;
            if (e.target.matches('[data-role]')) auth.impersonateRole(e.target.dataset.role);
            else if (e.target.matches('#stop-impersonating-btn')) auth.stopImpersonating();
            else if (e.target.closest('#god-config-btn')) showGodModeConfigModal();
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
                <button id="btn-sim-outage" class="toolbar-btn" style="border-color: red; color: #ff9999;">
                    🔥 Sim Outage (1m)
                </button>
                ${stopButtonHTML}
                <button id="god-config-btn" class="toolbar-btn" title="Site Configuration" style="margin-left: 10px; background: #444; border: 1px solid #666;">
                    ⚙
                </button>
            </div>
        </div>
    `;

    if (!debugBtn) {
        debugBtn = document.createElement('button');
        debugBtn.id = 'god-mode-debug-btn';
        debugBtn.textContent = 'D';
        Object.assign(debugBtn.style, {
            position: 'fixed', top: '12px', right: '60px', zIndex: '2147483647', // Max Z-Index
            width: '40px', height: '40px', borderRadius: '50%',
            backgroundColor: '#212529', color: '#ffffffff', border: '2px solid #92a392ff',
            fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.5)'
        });

        debugBtn.onclick = () => toggleDebugModal();
        document.body.appendChild(debugBtn);
    }
}

async function showGodModeConfigModal() {
    const { settings } = useAppStore.getState().siteSettings;
    const currentZoom = settings.themeVariables?.['--site-zoom'] || '100%';
    const currentPadding = settings.themeVariables?.['--global-padding'] || '1rem';
    const currentMargin = settings.themeVariables?.['--section-margin'] || '2rem';
    // NEW: Get current radius (default to 4px if missing)
    const currentRadius = settings.themeVariables?.['--border-radius'] || '4px';
    const inStoreOnly = settings.paymentConfig?.inStoreOnly || false;

    const modalHTML = `
        <div class="modal-form-container">
            <h3>God Config & Layout</h3>
            
            <form id="god-config-form">

                <!-- Zoom Control -->
                <div class="form-group">
                    <label>Global Zoom</label>
                    <div style="display:flex; gap:10px;">
                        <button type="button" class="button-secondary small zoom-btn" data-val="95%">95%</button>
                        <button type="button" class="button-secondary small zoom-btn" data-val="100%">100%</button>
                    </div>
                    <input type="hidden" name="zoomLevel" id="zoom-input" value="${currentZoom}">
                </div>
                
                <!-- Spacing Controls -->
                <div class="form-group">
                    <label>Global Padding</label>
                    <div style="display:flex; gap:5px; align-items:center;">
                        <button type="button" class="button-secondary small adjust-btn" data-target="padding-input" data-step="-2" data-unit="px">-</button>
                        <input type="text" name="globalPadding" id="padding-input" value="${currentPadding}" readonly style="width:70px; text-align:center;">
                        <button type="button" class="button-secondary small adjust-btn" data-target="padding-input" data-step="2" data-unit="px">+</button>
                    </div>
                </div>

                <div class="form-group">
                    <label>Section Margins</label>
                    <div style="display:flex; gap:5px; align-items:center;">
                        <button type="button" class="button-secondary small adjust-btn" data-target="margin-input" data-step="-2" data-unit="px">-</button>
                        <input type="text" name="sectionMargin" id="margin-input" value="${currentMargin}" readonly style="width:70px; text-align:center;">
                        <button type="button" class="button-secondary small adjust-btn" data-target="margin-input" data-step="2" data-unit="px">+</button>
                    </div>
                </div>

                <!-- NEW: Corner Rounding Control -->
                <div class="form-group">
                    <label>Corner Rounding (Border Radius)</label>
                    <div style="display:flex; gap:5px; align-items:center;">
                        <button type="button" class="button-secondary small adjust-btn" data-target="radius-input" data-step="-2" data-unit="px">-</button>
                        <input type="text" name="borderRadius" id="radius-input" value="${currentRadius}" readonly style="width:70px; text-align:center;">
                        <button type="button" class="button-secondary small adjust-btn" data-target="radius-input" data-step="2" data-unit="px">+</button>
                    </div>
                    <p style="font-size:0.8rem; color:#666; margin-top:5px;">Affects buttons, cards, and inputs.</p>
                </div>

                <div class="form-actions-split" style="justify-content: flex-end; margin-top:20px;">
                    <button type="submit" class="button-primary">Save All Changes</button>
                </div>
            </form>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    const form = document.getElementById('god-config-form');

    form.addEventListener('click', (e) => {
        // Zoom
        if (e.target.matches('.zoom-btn')) {
            const val = e.target.dataset.val;
            document.getElementById('zoom-input').value = val;
            document.body.style.zoom = val;
        }

        // Adjusters (+/-)
        if (e.target.matches('.adjust-btn')) {
            const targetId = e.target.dataset.target;
            const step = parseInt(e.target.dataset.step, 10);
            const unit = e.target.dataset.unit || 'px';
            const input = document.getElementById(targetId);

            // Regex to grab the number part (handle '1rem' vs '20px')
            const match = input.value.match(/(\d*\.?\d+)/);
            let currentVal = match ? parseFloat(match[0]) : 0;

            // If it was '1rem' (16px approx) and we are changing by px, conversions get messy. 
            // For simplicity in God Mode, we convert everything to 'px' once touched.
            if (input.value.includes('rem') && unit === 'px') {
                currentVal = currentVal * 16;
            }

            let newVal = Math.max(0, currentVal + step) + unit;
            input.value = newVal;

            // Live CSS Variable Updates
            if (targetId === 'padding-input') document.documentElement.style.setProperty('--global-padding', newVal);
            if (targetId === 'margin-input') document.documentElement.style.setProperty('--section-margin', newVal);
            // NEW: Radius update
            if (targetId === 'radius-input') document.documentElement.style.setProperty('--border-radius', newVal);
        }
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.textContent = "Saving...";
        btn.disabled = true;

        const formData = new FormData(form);
        const updates = {
            paymentConfig: {
                ...settings.paymentConfig,
                inStoreOnly: formData.get('inStoreOnly') === 'on'
            },
            themeVariables: {
                ...settings.themeVariables,
                '--site-zoom': formData.get('zoomLevel'),
                '--global-padding': formData.get('globalPadding'),
                '--section-margin': formData.get('sectionMargin'),
                '--border-radius': formData.get('borderRadius') // Save the new radius
            }
        };

        try {
            const { data: { session } } = await supabase.auth.getSession();
            await useAppStore.getState().siteSettings.updateSiteSettings(updates, session?.access_token);
            uiUtils.showToast('Config Saved!', 'success');
            uiUtils.closeModal();
        } catch (err) {
            console.error(err);
            uiUtils.showToast('Save failed', 'error');
            btn.disabled = false;
            btn.textContent = "Save All Changes";
        }
    });
}

function showDebugLogModalInternal() {
    // ... (Same as before, but wrap in a container div with class 'debug-modal-container' for easy closing)
    const logs = window.__LOG_HISTORY__ || [];
    // ... rowsHTML generation ...
    const rowsHTML = logs.map(log => {
        let color = log.type === 'error' ? '#ffcccc' : (log.type === 'warn' ? '#fff4cc' : '#f8f9fa');
        return `<tr style="background:${color}">
            <td style="padding:4px;font-size:11px;white-space:nowrap">${log.timestamp}</td>
            <td style="padding:4px;font-size:10px;font-weight:bold">${log.type.toUpperCase()}</td>
            <td style="padding:4px;font-size:12px;font-family:monospace;word-break:break-all">${log.message}</td>
        </tr>`;
    }).join('');

    const modalHTML = `
        <div class="debug-modal-container" style="height:80vh; display:flex; flex-direction:column;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                <h2 style="margin:0">Debug Console</h2>
                <button class="button-secondary small" onclick="document.querySelector('.debug-modal-container').closest('.modal-overlay').click()">Close</button>
            </div>
            <div style="flex:1; overflow:auto; border:1px solid #ccc;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr><th style="text-align:left">Time</th><th>Type</th><th>Message</th></tr>
                    </thead>
                    <tbody>${rowsHTML}</tbody>
                </table>
            </div>
        </div>
    `;
    uiUtils.showModal(modalHTML);
}
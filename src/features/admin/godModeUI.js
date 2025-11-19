// src/features/admin/godModeUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Creates and manages the God Mode Role Impersonation Toolbar.
 * This should be called once when the application initializes.
 */
export function initializeImpersonationToolbar() {
    // This subscriber will dynamically render the toolbar based on the auth state.
    useAppStore.subscribe(
        (state) => ({
            // THE FIX: We select the REAL profile to decide if the toolbar should show at all.
            // If we are impersonating, originalProfile holds the real one. If not, profile does.
            realProfile: state.auth.originalProfile || state.auth.profile,
            isImpersonating: state.auth.isImpersonating(),
            currentRole: state.auth.profile?.role || 'guest',
        }),
        ({ realProfile, isImpersonating, currentRole }) => {
            // We pass the real profile's role to the render function.
            renderToolbar(realProfile?.role, isImpersonating, currentRole);
        },
        { fireImmediately: true }
    );
}

/**
 * Renders or removes the toolbar based on the user's REAL role.
 * @param {'manager'|'owner'|'customer'|'guest'} realRole - The true role of the logged-in user.
 * @param {boolean} isImpersonating - Whether impersonation is active.
 * @param {string} currentRole - The currently displayed role.
 */
function renderToolbar(realRole, isImpersonating, currentRole) {
    let toolbar = document.getElementById('god-mode-toolbar');
    let debugBtn = document.getElementById('god-mode-debug-btn');

    // 1. Remove existing elements if not manager
    if (realRole !== 'manager') {
        if (toolbar) toolbar.remove();
        if (debugBtn) debugBtn.remove(); // Remove debug button too
        if (document.body.style.paddingBottom) document.body.style.paddingBottom = '';
        return;
    }

    // If the toolbar doesn't exist, create it.
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'god-mode-toolbar';
        document.body.appendChild(toolbar);
        document.body.style.paddingBottom = '60px';
        attachToolbarListeners(toolbar);
    }

    const stopButtonHTML = isImpersonating ? `
        <button id="stop-impersonating-btn" class="toolbar-btn stop-btn">Stop Impersonating</button>
    ` : '';
    
    toolbar.innerHTML = `
        <div class="toolbar-content">
             <span class="toolbar-label">
                <strong>God Mode:</strong> ${isImpersonating ? `Viewing as <strong>${currentRole.toUpperCase()}</strong>` : 'Active'}
            </span>
            <div class="toolbar-actions">
                <button class="toolbar-btn" data-role="guest">Guest</button>
                <button class="toolbar-btn" data-role="customer">Customer</button>
                <button class="toolbar-btn" data-role="owner">Owner</button>
                ${stopButtonHTML}
            </div>
        </div>
    `;

    // 3. Create "D" Debug Button (New Feature)
    if (!debugBtn) {
        debugBtn = document.createElement('button');
        debugBtn.id = 'god-mode-debug-btn';
        debugBtn.textContent = 'D';
        // Styling inline for simplicity, or add to CSS
        Object.assign(debugBtn.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            zIndex: '10001',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            backgroundColor: '#212529',
            color: '#75c075ff',
            border: '2px solid #95e295ff',
            fontWeight: 'bold',
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(0,0,0,0.5)'
        });
        debugBtn.onclick = showDebugLogModal;
        document.body.appendChild(debugBtn);
    }
}

/**
 * Attaches event listeners to the toolbar buttons. Only needs to be called once.
 */
function attachToolbarListeners(toolbar) {
    toolbar.addEventListener('click', (event) => {
        const target = event.target;
        // Get the actions from the correct namespace in the store
        const { impersonateRole, stopImpersonating } = useAppStore.getState().auth;

        if (target.matches('[data-role]')) {
            const roleToImpersonate = target.dataset.role;
            impersonateRole(roleToImpersonate);
        } else if (target.matches('#stop-impersonating-btn')) {
            stopImpersonating();
        }
    });
}


// --- Feature 2: Debug Log Viewer ---

function showDebugLogModal() {
    const logs = window.__LOG_HISTORY__ || [];
    
    // Generate Rows
    const rowsHTML = logs.map(log => {
        let color = '#333'; // Default (log)
        if (log.type === 'error') color = '#ffcccc';
        if (log.type === 'warn') color = '#fff4cc';
        if (log.type === 'info') color = '#ccf2ff';

        return `
            <tr style="background-color: ${color}; border-bottom: 1px solid #ccc;">
                <td style="padding: 5px; font-family: monospace; font-size: 11px; white-space: nowrap;">${log.timestamp}</td>
                <td style="padding: 5px; font-weight: bold; text-transform: uppercase; font-size: 10px;">${log.type}</td>
                <td style="padding: 5px; font-family: monospace; font-size: 12px; word-break: break-word;">${log.message}</td>
            </tr>
        `;
    }).join('');

    const modalHTML = `
        <div style="max-width: 90vw; height: 80vh; display: flex; flex-direction: column;">
            <h2 style="margin-top: 0;">Debug Console</h2>
            <div style="margin-bottom: 10px;">
                <button class="button-secondary small" onclick="window.location.reload()">Reload App</button>
                <button class="button-secondary small" onclick="navigator.clipboard.writeText(JSON.stringify(window.__LOG_HISTORY__))">Copy All JSON</button>
            </div>
            <div style="flex: 1; overflow-y: auto; border: 1px solid #ccc; background: #fff;">
                <table style="width: 100%; border-collapse: collapse;">
                    <thead style="position: sticky; top: 0; background: #eee; z-index: 1;">
                        <tr>
                            <th style="text-align: left; padding: 8px; width: 80px;">Time</th>
                            <th style="text-align: left; padding: 8px; width: 60px;">Type</th>
                            <th style="text-align: left; padding: 8px;">Message</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHTML}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    uiUtils.showModal(modalHTML);
}
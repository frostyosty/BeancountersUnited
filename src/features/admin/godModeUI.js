import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';
import { supabase } from '@/supabaseClient.js'; // Needed for saving settings

export function initializeImpersonationToolbar() {
    console.log("[GodModeUI] Initializing subscription...");
    
    useAppStore.subscribe(
        (state) => {
            const realRole = state.auth.originalProfile?.role || state.auth.profile?.role || 'guest';
            const isImp = state.auth.isImpersonating();
            const currRole = state.auth.profile?.role || 'guest';
            // Create a unique key to trigger updates only when these specific values change
            return `${realRole}|${isImp}|${currRole}`; 
        },
        (keyString) => {
            const [realRole, isImpStr, currentRole] = keyString.split('|');
            const isImpersonating = isImpStr === 'true';
            renderToolbar(realRole, isImpersonating, currentRole);
        },
        { fireImmediately: true }
    );
}

function renderToolbar(realRole, isImpersonating, currentRole) {
    let toolbar = document.getElementById('god-mode-toolbar');
    let debugBtn = document.getElementById('god-mode-debug-btn');

    // 1. Security Check: Only Managers (God Users) see this
    if (realRole !== 'manager') {
        if (toolbar) toolbar.remove();
        if (debugBtn) debugBtn.remove();
        if (document.body.style.paddingBottom) document.body.style.paddingBottom = '';
        return;
    }

    // 2. Create Toolbar if missing
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'god-mode-toolbar';
        document.body.appendChild(toolbar);
        document.body.style.paddingBottom = '60px'; // Push content up
        
        // Delegated listener for toolbar buttons
        toolbar.addEventListener('click', (e) => {
            const auth = useAppStore.getState().auth;
            
            if (e.target.matches('[data-role]')) {
                auth.impersonateRole(e.target.dataset.role);
            } 
            else if (e.target.matches('#stop-impersonating-btn')) {
                auth.stopImpersonating();
            }
            else if (e.target.closest('#god-config-btn')) {
                showGodModeConfigModal();
            }
        });
    }

    // 3. Render Toolbar Content
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
                
                <!-- NEW: Config Button -->
                <button id="god-config-btn" class="toolbar-btn" title="Site Configuration" style="margin-left: 10px; background: #444; border: 1px solid #666;">
                    ⚙️ Config
                </button>
            </div>
        </div>
    `;

    // 4. Ensure Debug "D" Button Exists
    if (!debugBtn) {
        debugBtn = document.createElement('button');
        debugBtn.id = 'god-mode-debug-btn';
        debugBtn.textContent = 'D';
        Object.assign(debugBtn.style, {
    position: 'fixed', 
    top: '12px', 
    right: '60px', // Moved left so it doesn't overlap hamburger
    zIndex: '1200',
            width: '40px', height: '40px', borderRadius: '50%',
            backgroundColor: '#212529', color: '#00ff00', border: '2px solid #00ff00',
            fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 2px 10px rgba(0,0,0,0.5)'
        });
        
        debugBtn.onclick = () => {
            if (window.showDebugLogModal) window.showDebugLogModal(); // Calls function defined in debugLogger.js (if attached to window)
            else showDebugLogModalInternal(); // Fallback local version
        };
        document.body.appendChild(debugBtn);
    }
}

// --- NEW: God Mode Configuration Modal ---
function showGodModeConfigModal() {
    // Get current settings
    const currentSpinner = localStorage.getItem('site_spinner_type') || 'coffee';

    const modalHTML = `
        <div class="modal-form-container">
            <h3>God Mode Configuration</h3>
            <p style="color:#666; margin-bottom:20px;">Global settings for the application instance.</p>
            
            <form id="god-config-form">
                <div class="form-row">
                    <label>Loading Animation (Brand Identity)</label>
                    <div style="display:flex; gap:20px; margin-top:10px;">
                        <label style="font-weight:normal; cursor:pointer; display:flex; align-items:center; gap:8px; padding:10px; border:1px solid #ccc; border-radius:6px;">
                            <input type="radio" name="spinnerType" value="coffee" ${currentSpinner === 'coffee' ? 'checked' : ''}> 
                            ☕ Coffee (Restaurant)
                        </label>
                        <label style="font-weight:normal; cursor:pointer; display:flex; align-items:center; gap:8px; padding:10px; border:1px solid #ccc; border-radius:6px;">
                            <input type="radio" name="spinnerType" value="hammer" ${currentSpinner === 'hammer' ? 'checked' : ''}> 
                            🔨 Hammer (Construction)
                        </label>
                    </div>
                    <p style="font-size:0.85rem; color:#888; margin-top:5px;">
                        Changes the initial loading screen and auth spinner.
                    </p>
                </div>

                <div class="form-actions-split" style="justify-content: flex-end;">
                    <button type="submit" class="button-primary">Save Configuration</button>
                </div>
            </form>
        </div>
    `;

    uiUtils.showModal(modalHTML);

    // Attach Listeners
    const form = document.getElementById('god-config-form');
    
    // Live Preview Listener
    form.addEventListener('change', (e) => {
        if (e.target.name === 'spinnerType') {
            const newType = e.target.value;
            // Apply immediately to see the change (e.g. in the auth spinner if visible)
            uiUtils.setGlobalSpinner(newType);
            uiUtils.showToast(`Previewing: ${newType} spinner`, 'info');
        }
    });

    // Save Listener
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(form);
        const newSpinnerType = formData.get('spinnerType');

        const btn = form.querySelector('button[type="submit"]');
        btn.textContent = "Saving...";
        btn.disabled = true;

        try {
            // 1. Local Storage (Instant)
            uiUtils.setGlobalSpinner(newSpinnerType);

            // 2. Database (Persist for everyone)
            const { data: { session } } = await supabase.auth.getSession();
            await useAppStore.getState().siteSettings.updateSiteSettings(
                { spinnerType: newSpinnerType }, 
                session?.access_token
            );

            uiUtils.showToast('Global configuration saved!', 'success');
            uiUtils.closeModal();
        } catch (error) {
            console.error("Config Save Failed:", error);
            uiUtils.showToast('Failed to save config.', 'error');
            btn.textContent = "Save Configuration";
            btn.disabled = false;
        }
    });
}

// --- INTERNAL DEBUG LOG VIEWER (Fallback if not global) ---
function showDebugLogModalInternal() {
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
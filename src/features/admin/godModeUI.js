// src/features/admin/godModeUI.js
import { useAppStore } from '@/store/appStore.js';

/**
 * Creates and manages the God Mode Role Impersonation Toolbar.
 * This function should be called once when the application initializes.
 */
export function initializeImpersonationToolbar() {
    // The toolbar will listen to state changes to render itself.
    // We only need to set up the subscription once.

    useAppStore.subscribe(
        // The selector: listen to the real profile and the impersonation status.
        (state) => ({
            realRole: state.originalProfile?.role || state.profile?.role,
            isImpersonating: state.isImpersonating(),
            currentRole: state.profile?.role || 'guest',
        }),
        // The callback: this function runs when the selected state changes.
        ({ realRole, isImpersonating, currentRole }) => {
            renderToolbar(realRole, isImpersonating, currentRole);
        },
        { fireImmediately: true } // Run once on startup to set the initial state
    );
}

/**
 * Renders or removes the toolbar based on the user's real role.
 * @param {string} realRole - The true role of the logged-in user.
 * @param {boolean} isImpersonating - Whether impersonation is active.
 * @param {string} currentRole - The currently displayed role.
 */
function renderToolbar(realRole, isImpersonating, currentRole) {
    let toolbar = document.getElementById('god-mode-toolbar');

    // --- SECURITY GATE: Only render the toolbar if the real user is a manager ---
    if (realRole !== 'manager') {
        if (toolbar) toolbar.remove(); // If it exists for some reason, remove it.
        return;
    }

    // If the toolbar doesn't exist, create it.
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'god-mode-toolbar';
        document.body.appendChild(toolbar);
        // Add padding to the bottom of the body so the toolbar doesn't cover content.
        document.body.style.paddingBottom = '60px';
    }

    const stopButtonHTML = `
        <button id="stop-impersonating-btn" class="toolbar-btn stop-btn">
            Stop Impersonating (Return to God Mode)
        </button>
    `;

    toolbar.innerHTML = `
        <div class="toolbar-content">
            <span class="toolbar-label">
                <strong>God Mode:</strong>
                ${isImpersonating ? `Currently viewing as <strong>${currentRole.toUpperCase()}</strong>` : 'You are in God Mode.'}
            </span>
            <div class="toolbar-actions">
                <span>View as:</span>
                <button class="toolbar-btn" data-role="guest">Guest</button>
                <button class="toolbar-btn" data-role="customer">Customer</button>
                <button class="toolbar-btn" data-role="owner">Owner</button>
                ${isImpersonating ? stopButtonHTML : ''}
            </div>
        </div>
    `;

    // Add event listeners after rendering
    attachToolbarListeners();
}

/**
 * Attaches event listeners to the toolbar buttons.
 */
function attachToolbarListeners() {
    const toolbar = document.getElementById('god-mode-toolbar');
    if (!toolbar) return;

    toolbar.addEventListener('click', (event) => {
        const target = event.target;
        const { impersonateRole, stopImpersonating } = useAppStore.getState();

        if (target.matches('[data-role]')) {
            const roleToImpersonate = target.dataset.role;
            impersonateRole(roleToImpersonate);
        } else if (target.matches('#stop-impersonating-btn')) {
            stopImpersonating();
        }
    });
}
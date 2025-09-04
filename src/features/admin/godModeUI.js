// src/features/admin/godModeUI.js
import { useAppStore } from '@/store/appStore.js';

/**
 * Creates and manages the God Mode Role Impersonation Toolbar.
 * This should be called once when the application initializes.
 */
export function initializeImpersonationToolbar() {
    // This subscriber will dynamically render the toolbar based on the auth state.
    useAppStore.subscribe(
        // The selector: we need the REAL profile to decide if the toolbar should show at all.
        // And the CURRENT profile to know what role is being impersonated.
        (state) => ({
            realProfile: state.auth.originalProfile || state.auth.profile,
            currentProfile: state.auth.profile,
            isImpersonating: state.auth.isImpersonating(),
        }),
        ({ realProfile, currentProfile, isImpersonating }) => {
            renderToolbar(realProfile, currentProfile, isImpersonating);
        },
        { fireImmediately: true } // Run once on startup
    );
}

/**
 * Renders or removes the toolbar based on the user's real role.
 */
function renderToolbar(realProfile, currentProfile, isImpersonating) {
    let toolbar = document.getElementById('god-mode-toolbar');
    const realRole = realProfile?.role;
    const currentRole = currentProfile?.role || 'guest';

    // --- SECURITY GATE: Only the 'manager' (God User) should ever see this toolbar. ---
    if (realRole !== 'manager') {
        if (toolbar) toolbar.remove();
        document.body.style.paddingBottom = '0'; // Reset padding
        return;
    }

    // If the toolbar doesn't exist, create it.
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'god-mode-toolbar';
        document.body.appendChild(toolbar);
        // Add padding to the bottom of the body so the toolbar doesn't cover content.
        document.body.style.paddingBottom = '60px';
        attachToolbarListeners(toolbar);
    }

    const stopButtonHTML = isImpersonating ? `
        <button id="stop-impersonating-btn" class="toolbar-btn stop-btn">
            Stop Impersonating (Return to God Mode)
        </button>
    ` : '';

    toolbar.innerHTML = `
        <div class="toolbar-content">
            <span class="toolbar-label">
                <strong>God Mode Toolbar:</strong>
                ${isImpersonating ? `Currently viewing as <strong>${currentRole.toUpperCase()}</strong>` : 'You are in God Mode.'}
            </span>
            <div class="toolbar-actions">
                <span>View Site As:</span>
                <button class="toolbar-btn" data-role="guest">Guest</button>
                <button class="toolbar-btn" data-role="customer">Customer</button>
                <button class="toolbar-btn" data-role="owner">Owner</button>
                ${stopButtonHTML}
            </div>
        </div>
    `;
}

/**
 * Attaches event listeners to the toolbar buttons.
 */
function attachToolbarListeners(toolbar) {
    toolbar.addEventListener('click', (event) => {
        const target = event.target;
        const { impersonateRole, stopImpersonating } = useAppStore.getState().auth;

        if (target.matches('[data-role]')) {
            const roleToImpersonate = target.dataset.role;
            impersonateRole(roleToImpersonate);
        } else if (target.matches('#stop-impersonating-btn')) {
            stopImpersonating();
        }
    });
}
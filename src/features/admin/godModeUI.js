// src/features/admin/godModeUI.js
import { useAppStore } from '@/store/appStore.js';

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

    // --- SECURITY GATE: Only render the toolbar if the REAL user is a manager ---
    if (realRole !== 'manager') {
        if (toolbar) toolbar.remove(); // If it exists for some reason, remove it.
        // Reset body padding if the toolbar is removed
        if (document.body.style.paddingBottom) {
            document.body.style.paddingBottom = '';
        }
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
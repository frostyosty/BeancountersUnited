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
            // We select the REAL role to decide if the toolbar should show at all.
            realRole: state.auth.originalProfile?.role || state.auth.profile?.role,
            isImpersonating: state.auth.isImpersonating(),
            currentRole: state.auth.profile?.role || 'guest',
        }),
        ({ realRole, isImpersonating, currentRole }) => {
            renderToolbar(realRole, isImpersonating, currentRole);
        },
        { fireImmediately: true }
    );
}

function renderToolbar(realRole, isImpersonating, currentRole) {
    let toolbar = document.getElementById('god-mode-toolbar');

    // SECURITY GATE: Only the 'manager' (God User) should ever see this toolbar.
    if (realRole !== 'manager') {
        if (toolbar) toolbar.remove();
        document.body.style.paddingBottom = '0';
        return;
    }

    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = 'god-mode-toolbar';
        document.body.appendChild(toolbar);
        document.body.style.paddingBottom = '60px'; // Prevent content from being hidden
        attachToolbarListeners(toolbar); // Attach listener only once
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
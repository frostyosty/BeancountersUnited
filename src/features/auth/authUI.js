// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
// We will add back uiUtils and login/signup logic in the next step.
// For now, we just want to render the status.

/**
 * Renders the authentication status in the header.
 */
export function renderAuthStatus() {
    console.log("--- renderAuthStatus() CALLED ---");
    const authContainer = document.getElementById('auth-status-container');
    if (!authContainer) {
        console.warn("renderAuthStatus: #auth-status-container not found.");
        return;
    };

    const { isAuthenticated, user, isAuthLoading } = useAppStore.getState();
    console.log("renderAuthStatus: Rendering with state:", { isAuthenticated, isAuthLoading });

    if (isAuthLoading) {
        authContainer.innerHTML = `<span>...</span>`;
        return;
    }

    if (isAuthenticated) {
        authContainer.innerHTML = `<div class="user-info">Welcome, ${user.email}</div>`;
    } else {
        authContainer.innerHTML = `<button id="login-btn" class="button-primary">Login</button>`;
    }

    // We will add event listeners back later.
}
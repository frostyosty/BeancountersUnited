// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

export function renderAuthStatus() {
    const authContainer = document.getElementById('auth-status-container');
    if (!authContainer) return;

    const { isAuthenticated, user, profile, isAuthLoading, getUserRole } = useAppStore.getState().auth;
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

async function handleAuthFormSubmit(event) {
    // ...
    // Correctly get actions from the 'auth' namespace
    const { login, signUp } = useAppStore.getState().auth;
    // ...
}
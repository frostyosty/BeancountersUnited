// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Renders the authentication status in the header.
 * This is the ONLY exported function we'll use in the main render loop.
 */
export function renderAuthStatus() {
    const authContainer = document.getElementById('auth-status-container');
    if (!authContainer) return;

    const { isAuthenticated, user, profile, isAuthLoading } = useAppStore.getState().auth;

    if (isAuthLoading) {
        authContainer.innerHTML = `<span>...</span>`;
        return;
    }

    if (isAuthenticated) {
        const userRole = profile?.role || 'customer';
        let dashboardLinks = '';
        if (userRole === 'owner' || userRole === 'manager') {
            dashboardLinks = `<a href="#owner-dashboard" class="nav-link">Owner Dashboard</a>`;
        }
        if (userRole === 'manager') {
            dashboardLinks += `<a href="#manager-dashboard" class="nav-link">God Mode</a>`;
        }
        authContainer.innerHTML = `
            <div class="user-info">
                <span>${user.email}</span>
                ${dashboardLinks}
                <button id="logout-btn" class="button-secondary">Logout</button>
            </div>
        `;
    } else {
        authContainer.innerHTML = `
            <button id="login-btn" class="button-primary">Login</button>
            <button id="signup-btn" class="button-secondary">Sign Up</button>
        `;
    }
    // The main render loop handles re-attaching listeners implicitly now.
}

// --- Event Handlers (Not exported, attached by main.js) ---





/**
 * Handles the submission of the LOGIN form.
 * @param {Event} event
 */
async function handleLoginFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    const messageEl = document.getElementById('login-message');
    const email = form.email.value;
    const password = form.password.value;
    const { login } = useAppStore.getState().auth;

    // Provide immediate feedback
    submitButton.disabled = true;
    submitButton.textContent = 'Logging In...';
    messageEl.textContent = '';
    messageEl.className = 'auth-message';

    const { error } = await login(email, password);

    if (error) {
        messageEl.textContent = error.message;
        messageEl.className = 'auth-message error';
        submitButton.disabled = false;
        submitButton.textContent = 'Login';
    } else {
        // Success is handled by the onAuthStateChange listener
        uiUtils.showToast('Login successful!', 'success');
        uiUtils.closeModal();
    }
}


/**
 * Handles the submission of the SIGN UP form.
 * @param {Event} event
 */
async function handleSignupFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    const messageEl = document.getElementById('signup-message');
    const email = form.email.value;
    const password = form.password.value;
    const { signUp } = useAppStore.getState().auth;

    // Provide immediate feedback
    submitButton.disabled = true;
    submitButton.textContent = 'Signing Up...';
    messageEl.textContent = '';
    messageEl.className = 'auth-message';

    const { error } = await signUp(email, password);

    if (error) {
        messageEl.textContent = error.message;
        messageEl.className = 'auth-message error';
        submitButton.disabled = false;
        submitButton.textContent = 'Sign Up';
    } else {
        // On success, we don't close the modal. We show instructions.
        messageEl.textContent = 'Success! Please check your email for a confirmation link.';
        messageEl.className = 'auth-message success';
        // The button remains disabled to prevent multiple signups.
    }
}


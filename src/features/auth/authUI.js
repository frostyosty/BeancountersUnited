// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Renders the authentication status in the header.
 */
export function renderAuthStatus() {
    const container = document.getElementById('auth-status-container');
    if (!container) return;

    const { user, profile, isAuthLoading } = useAppStore.getState().auth;

    // 1. LOADING STATE: Use the SVG spinner
    if (isAuthLoading) {
        container.innerHTML = `
            <div class="auth-loading-spinner">
                <svg viewBox="0 0 100 100">
                    <path d="M22 40 H 78 L 72 80 Q 50 90 28 80 Z" fill="transparent" stroke="currentColor" stroke-width="6" />
                    <path d="M78 50 C 92 50, 92 70, 78 70" fill="transparent" stroke="currentColor" stroke-width="6" />
                    <path class="mini-steam" d="M40 35 L 42 25" fill="none" stroke="currentColor" stroke-width="4" />
                    <path class="mini-steam" d="M50 35 L 48 25" fill="none" stroke="currentColor" stroke-width="4" />
                    <path class="mini-steam" d="M60 35 L 62 25" fill="none" stroke="currentColor" stroke-width="4" />
                </svg>
            </div>
        `;
        return;
    }

    // 2. LOGGED IN STATE
    if (user) {
        // Use a fallback display name if profile isn't loaded yet
        const displayName = profile?.full_name || user.email.split('@')[0];
        
        // Add a badge if Manager/Owner
        let badge = '';
        if (profile?.role === 'manager') badge = '<span class="role-badge manager">GOD</span>';
        else if (profile?.role === 'owner') badge = '<span class="role-badge owner">OWNER</span>';

        container.innerHTML = `
            <div class="auth-user-display">
                <span class="user-greeting">Hi, ${displayName}</span>
                ${badge}
                <button id="logout-btn" class="button-link">Logout</button>
            </div>
        `;
    } 
    // 3. LOGGED OUT STATE
    else {
        container.innerHTML = `
            <button id="login-signup-btn" class="button-primary small">Login</button>
        `;
    }
}

/**
 * Displays a modal with side-by-side Login and Sign Up forms.
 */
export function showLoginSignupModal() {
    const modalContentHTML = `
        <div class="auth-modal-container">
            <div class="auth-form-section">
                <h2>Login</h2>
                <form id="login-form" novalidate>
                    <div class="form-group">
                        <label for="login-email">Email</label>
                        <input type="email" id="login-email" name="email" required autocomplete="email">
                    </div>
                    <div class="form-group">
                        <label for="login-password">Password</label>
                        <input type="password" id="login-password" name="password" required autocomplete="current-password">
                    </div>
                    <p id="login-message" class="auth-message"></p>
                    <div class="form-actions">
                        <button type="submit" class="button-primary">Login</button>
                    </div>
                </form>
            </div>
            <div class="auth-divider"></div>
            <div class="auth-form-section">
                <h2>Sign Up</h2>
                <form id="signup-form" novalidate>
                     <div class="form-group">
                        <label for="signup-email">Email</label>
                        <input type="email" id="signup-email" name="email" required autocomplete="email">
                    </div>
                    <div class="form-group">
                        <label for="signup-password">Password (min. 6 characters)</label>
                        <input type="password" id="signup-password" name="password" required minlength="6" autocomplete="new-password">
                    </div>
                    <p id="signup-message" class="auth-message"></p>
                    <div class="form-actions">
                        <button type="submit" class="button-secondary">Sign Up</button>
                    </div>
                </form>
            </div>
        </div>
    `;
    uiUtils.showModal(modalContentHTML);

    document.getElementById('login-form')?.addEventListener('submit', handleLoginFormSubmit);
    document.getElementById('signup-form')?.addEventListener('submit', handleSignupFormSubmit);
}

/**
 * Handles the submission of the LOGIN form.
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
        // Don't need to close modal manually; auth state change will trigger UI updates.
        uiUtils.showToast('Login successful!', 'success');
    }
}

/**
 * Handles the submission of the SIGN UP form.
 */
async function handleSignupFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    const messageEl = document.getElementById('signup-message');
    const email = form.email.value;
    const password = form.password.value;
    const { signUp } = useAppStore.getState().auth;

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
        messageEl.textContent = 'Success! Please check your email for a confirmation link.';
        messageEl.className = 'auth-message success';
    }
}
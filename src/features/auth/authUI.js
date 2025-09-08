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

        // Add dashboard links based on role
        if (userRole === 'owner' || userRole === 'manager') {
            dashboardLinks += `<a href="#owner-dashboard" class="nav-link">Owner Dashboard</a>`;
        }
        if (userRole === 'manager') {
            dashboardLinks += `<a href="#manager-dashboard" class="nav-link">God Mode</a>`;
        }

        // The user's email and the new "Order History" link are always shown for logged-in users.
        authContainer.innerHTML = `
            <div class="user-info">
                <span>${user.email}</span>
                <a href="#order-history" class="nav-link">Order History</a>
                ${dashboardLinks}
                <button id="logout-btn" class="button-secondary">Logout</button>
            </div>
        `;
    } else {
        // This part remains the same for logged-out users
    //     authContainer.innerHTML = `
    //         <button id="login-signup-btn" class="button-primary">Login / Sign Up</button>
    //     `;
    // }
        authContainer.innerHTML = `
            <button id="login-btn" class="button-primary">Login</button>
            <button id="signup-btn" class="button-secondary">Sign Up</button>
        `;
    }
    // The main render loop handles re-attaching listeners implicitly now.
}




/**
 * Displays a modal with side-by-side Login and Sign Up forms.
 * It is EXPORTED so main.js can import and use it.
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


// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

/**
 * Renders the authentication status in the header (e.g., "Login" button or "Welcome, User").
 * Reads the latest state from the store and updates the DOM accordingly.
 */
export function renderAuthStatus() {
    const authContainer = document.getElementById('auth-status-container');
    if (!authContainer) return;

    // Read properties directly from the flat store state
    const { isAuthenticated, user, isAuthLoading } = useAppStore.getState();

    // If we're still performing the initial check, show a minimal loading state.
    if (isAuthLoading) {
        authContainer.innerHTML = `<span>...</span>`;
        return;
    }

    let contentHTML = '';

    if (isAuthenticated) {
        // --- LOGGED-IN VIEW ---
        const userRole = getUserRole(); // Use the selector to get the role
        let dashboardLinks = '';

        if (userRole === 'owner' || userRole === 'manager') {
            dashboardLinks += `<a href="#owner-dashboard" class="nav-link">Owner Dashboard</a>`;
        }
        if (userRole === 'manager') {
            dashboardLinks += `<a href="#manager-dashboard" class="nav-link">God Mode</a>`;
        }

        contentHTML = `
            <div class="user-info">
                <span>Welcome, ${user.email}</span>
                ${dashboardLinks}
                <button id="logout-btn" class="button-secondary">Logout</button>
            </div>
        `;
    } else {
        // --- LOGGED-OUT VIEW ---
        contentHTML = `
            <button id="login-btn" class="button-primary">Login / Sign Up</button>
        `;
    }

    authContainer.innerHTML = contentHTML;
    attachAuthEventListeners();
}

/**
 * Attaches event listeners for the auth-related buttons.
 * This function is idempotent (safe to call multiple times) by cloning nodes to remove old listeners.
 */
function attachAuthEventListeners() {
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
        const newLoginBtn = loginBtn.cloneNode(true);
        loginBtn.parentNode.replaceChild(newLoginBtn, loginBtn);
        newLoginBtn.addEventListener('click', showLoginModal);
    }

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        const newLogoutBtn = logoutBtn.cloneNode(true);
        logoutBtn.parentNode.replaceChild(newLogoutBtn, logoutBtn);
        newLogoutBtn.addEventListener('click', async () => {
            await useAppStore.getState().logout();
            uiUtils.showToast('You have been logged out.', 'info');
        });
    }
}

/**
 * Displays the login/signup modal.
 */
function showLoginModal() {
    const modalContentHTML = `
        <div class="auth-modal">
            <h2>Login or Sign Up</h2>
            <form id="auth-form">
                <div class="form-group">
                    <label for="auth-email">Email</label>
                    <input type="email" id="auth-email" name="email" required autocomplete="email">
                </div>
                <div class="form-group">
                    <label for="auth-password">Password</label>
                    <input type="password" id="auth-password" name="password" required autocomplete="current-password">
                </div>
                <p id="auth-message" class="auth-message"></p>
                <div class="form-actions">
                    <button type="submit" class="button-primary">Continue</button>
                </div>
            </form>
        </div>
    `;
    uiUtils.showModal(modalContentHTML);

    const authForm = document.getElementById('auth-form');
    if (authForm) {
        authForm.addEventListener('submit', handleAuthFormSubmit);
    }
}

/**
 * Handles the submission of the login/signup form.
 */
async function handleAuthFormSubmit(event) {
    event.preventDefault();
    const messageEl = document.getElementById('auth-message');
    const email = event.target.email.value;
    const password = event.target.password.value;
    const { login, signUp } = useAppStore.getState();

    messageEl.textContent = 'Processing...';
    messageEl.className = 'auth-message info';

    const { error: loginError } = await login(email, password);

    if (loginError) {
        if (loginError.message.includes('Invalid login credentials')) {
            messageEl.textContent = 'Account not found. Attempting to sign you up...';
            const { error: signUpError } = await signUp(email, password);
            if (signUpError) {
                messageEl.textContent = `Sign up failed: ${signUpError.message}`;
                messageEl.className = 'auth-message error';
            } else {
                messageEl.textContent = 'Success! Please check your email for a confirmation link.';
                messageEl.className = 'auth-message success';
            }
        } else {
            messageEl.textContent = loginError.message;
            messageEl.className = 'auth-message error';
        }
    } else {
        // Successful login is handled by the onAuthStateChange listener which will
        // update the state and trigger a re-render via the subscriber in main.js.
        uiUtils.showToast('Login successful!', 'success');
        uiUtils.closeModal();
    }
}
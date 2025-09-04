// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

export function renderAuthStatus() {
    const authContainer = document.getElementById('auth-status-container');
    if (!authContainer) return;

    const { isAuthenticated, user, profile, isAuthLoading, getUserRole } = useAppStore.getState().auth;

    if (isAuthLoading) {
        authContainer.innerHTML = `<span>...</span>`;
        return;
    }

    if (isAuthenticated) {
        const userRole = getUserRole();
        let dashboardLinks = '';
        if (userRole === 'owner' || userRole === 'manager') {
            dashboardLinks += `<a href="#owner-dashboard" class="nav-link">Owner Dashboard</a>`;
        }
        if (userRole === 'manager') {
            dashboardLinks += `<a href="#manager-dashboard" class="nav-link">God Mode</a>`;
        }
        authContainer.innerHTML = `<div class="user-info"><span>Welcome, ${user.email}</span>${dashboardLinks}<button id="logout-btn" class="button-secondary">Logout</button></div>`;
    } else {
        authContainer.innerHTML = `<button id="login-btn" class="button-primary">Login / Sign Up</button>`;
    }
    attachAuthEventListeners();
}

function attachAuthEventListeners() {
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', showLoginModal);
    }
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => useAppStore.getState().auth.logout());
    }
}
/**
 * Displays the login/signup modal.
 */
function showLoginModal() {
    const modalContentHTML = `
        <div class="auth-modal">
            <h2>Login or Sign Up</h2>
            <form id="auth-form" novalidate>
                <div class="form-group">
                    <label for="auth-email">Email</label>
                    <input type="email" id="auth-email" name="email" required autocomplete="email" placeholder="you@example.com">
                </div>
                <div class="form-group">
                    <label for="auth-password">Password</label>
                    <input type="password" id="auth-password" name="password" required minlength="6" autocomplete="current-password" placeholder="••••••••">
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
 * @param {Event} event
 */
async function handleAuthFormSubmit(event) {
    event.preventDefault(); // Prevent default form submission
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    const messageEl = document.getElementById('auth-message');
    const email = form.email.value;
    const password = form.password.value;
    
    // Get the actions from our Zustand store
    const { login, signUp } = useAppStore.getState().auth;

    // Provide immediate feedback to the user
    submitButton.disabled = true;
    submitButton.textContent = 'Processing...';
    messageEl.textContent = '';
    messageEl.className = 'auth-message';

    // First, attempt to log the user in.
    const { error: loginError } = await login(email, password);

    if (loginError) {
        // If login fails because the user doesn't exist, try to sign them up.
        if (loginError.message.includes('Invalid login credentials')) {
            messageEl.textContent = 'Account not found. Attempting to sign you up...';
            messageEl.className = 'auth-message info';

            const { error: signUpError } = await signUp(email, password);

            if (signUpError) {
                messageEl.textContent = `Sign up failed: ${signUpError.message}`;
                messageEl.className = 'auth-message error';
            } else {
                messageEl.textContent = 'Success! Please check your email for a confirmation link to complete your registration.';
                messageEl.className = 'auth-message success';
                // We leave the modal open so the user sees this message.
                // We also disable the button to prevent re-submission.
                return; // Exit the function here
            }
        } else {
            // Handle other login errors (e.g., wrong password, email not confirmed)
            messageEl.textContent = loginError.message;
            messageEl.className = 'auth-message error';
        }
    } else {
        // Login was successful. The onAuthStateChange listener will handle the UI update.
        uiUtils.showToast('Login successful!', 'success');
        uiUtils.closeModal();
    }

    // Re-enable the button if there was an error
    submitButton.disabled = false;
    submitButton.textContent = 'Continue';
}
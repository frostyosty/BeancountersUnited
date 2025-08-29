// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

export function renderAuthStatus() {
    const authContainer = document.getElementById('auth-status-container');
    if (!authContainer) return;

    const { isAuthenticated, user, profile, isAuthLoading } = useAppStore.getState();

    if (isAuthLoading) {
        authContainer.innerHTML = `<span>...</span>`;
        return;
    }

    let contentHTML = '';

    if (isAuthenticated) {
        const userRole = profile?.role || 'customer';
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
        contentHTML = `
            <button id="login-btn" class="button-primary">Login / Sign Up</button>
        `;
    }

    authContainer.innerHTML = contentHTML;
    attachAuthEventListeners();
}

function attachAuthEventListeners() {
    const oldLoginBtn = document.getElementById('login-btn');
    if (oldLoginBtn) oldLoginBtn.replaceWith(oldLoginBtn.cloneNode(true));
    document.getElementById('login-btn')?.addEventListener('click', showLoginModal);

    const oldLogoutBtn = document.getElementById('logout-btn');
    if (oldLogoutBtn) oldLogoutBtn.replaceWith(oldLogoutBtn.cloneNode(true));
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
        await useAppStore.getState().logout();
        uiUtils.showToast('You have been logged out.', 'info');
    });
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
        // Successful login is handled by the onAuthStateChange listener
        uiUtils.showToast('Login successful!', 'success');
        uiUtils.closeModal();
    }
}
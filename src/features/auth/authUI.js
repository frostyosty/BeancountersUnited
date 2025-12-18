import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js'; // Needed for modal

export function renderAuthStatus() {
    const container = document.getElementById('auth-status-container');
    if (!container) return;

    const { user, profile, isAuthLoading } = useAppStore.getState().auth;

    // 1. LOADING
    if (isAuthLoading) {
        // This will be populated by initGlobalSpinner(), just put a placeholder
        container.innerHTML = `<div class="auth-loading-spinner"></div>`;
        uiUtils.initGlobalSpinner(); // Re-inject SVG if needed
        return;
    }

    // 2. LOGGED IN
    if (user) {
        const role = profile?.role;
        let displayHTML = '';

        if (role === 'god') {
            displayHTML = `<span class="role-badge god" style="background:black; color:white; padding:2px 6px; border-radius:4px; font-size:0.8rem; font-weight:bold;">GOD MODE</span>`;
        } else if (role === 'owner') {
            displayHTML = `<span class="role-badge owner" style="background:mauve; color:white; padding:2px 6px; border-radius:4px; font-size:0.8rem; font-weight:bold;">OWNER</span>`;
        } else {
            const name = profile?.full_name || user.email.split('@')[0];
            displayHTML = `<span class="user-greeting" style="font-size:0.9rem;">Hi, ${name}</span>`;
        }

        container.innerHTML = `
            <div class="auth-user-display" style="display:flex; align-items:center; gap:10px;">
                ${displayHTML}
                <button id="logout-btn" class="button-link" style="font-size:0.9rem; text-decoration:underline; cursor:pointer; border:none; background:none; color:var(--text-color);">Logout</button>
            </div>
        `;
    } 
    // 3. LOGGED OUT
    else {
        container.innerHTML = `
            <button id="login-signup-btn" class="button-primary small" style="font-size:0.8rem; padding: 6px 12px;">Login / Sign Up</button>
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

    // 1. Call Store
     if (error) {
        // --- NEW: Copy values to Sign Up form for convenience ---
        const signupEmail = document.getElementById('signup-email');
        const signupPass = document.getElementById('signup-password');
        if (signupEmail) signupEmail.value = email;
        if (signupPass) signupPass.value = password;
        // -------------------------------------------------------

        let msg = error.message;
        
        // FIX: Sanitize technical jargon
        if (msg.includes("Invalid login credentials")) {
            msg = "Incorrect email or password.";
        } else if (msg.includes("AuthApiError")) {
            msg = "Login failed. Please check your details.";
        }

        // Show in red text
        messageEl.textContent = msg;
        messageEl.className = 'auth-message error';
        
        // Also show a toast for visibility
        uiUtils.showToast(msg, 'error');

        // Reset button
        submitButton.disabled = false;
        submitButton.textContent = 'Login';
    } else {
        uiUtils.showToast('Login successful!', 'success');
        // Modal closes automatically via auth state change
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
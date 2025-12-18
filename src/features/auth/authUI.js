// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

// Helper: Distinguish Email vs Username
function isEmail(input) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

// Helper: Convert Input to Supabase Login format
function formatLoginString(input) {
    const trimmed = input.trim();
    if (isEmail(trimmed)) return trimmed;
    // It's a username -> Append dummy domain
    return `${trimmed}@mealmates.local`; 
}


async function handleAuthSubmit(event, type) {
    event.preventDefault();
    const form = event.target;
    const btn = form.querySelector('button[type="submit"]');
    const msgEl = form.querySelector('.auth-message');
    
    const rawInput = form.identifier.value.trim();
    const password = form.password.value;
    const { login, signUp } = useAppStore.getState().auth;

    // Validation
    if (rawInput.length < 3) {
        msgEl.textContent = "Username/Email is too short.";
        msgEl.className = 'auth-message error';
        return;
    }

    // Save for next time
    localStorage.setItem('last_login_input', rawInput);

    // Prepare Creds
    const emailPayload = formatLoginString(rawInput);
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Processing...';
    msgEl.textContent = '';

    try {
        const action = type === 'login' ? login : signUp;
        const result = await action(emailPayload, password);
        const error = result.error;

        if (error) {
            let msg = error.message;
            if (msg.includes("Invalid login credentials")) msg = "Incorrect username/email or password.";
            
            msgEl.textContent = msg;
            msgEl.className = 'auth-message error';
            uiUtils.showToast(msg, 'error');
            
            // Auto-fill other form
            const otherInput = document.getElementById(type === 'login' ? 'signup-input' : 'login-input');
            const otherPass = document.getElementById(type === 'login' ? 'signup-password' : 'login-password');
            if (otherInput) otherInput.value = rawInput;
            if (otherPass) otherPass.value = password;

            btn.disabled = false;
            btn.textContent = originalText;
        } else {
            uiUtils.showToast(`${type === 'login' ? 'Welcome back' : 'Account created'}!`, 'success');
            uiUtils.closeModal();
            // Store specific guest name if using username
            if (!isEmail(rawInput)) localStorage.setItem('guest_name', rawInput);
        }
    } catch (e) {
        console.error(e);
        msgEl.textContent = "System Error.";
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

// --- Helper: Email Validation ---
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// --- 1. AUTH STATUS (Header) ---
export function renderAuthStatus() {
    const container = document.getElementById('auth-status-container');
    if (!container) return;

    const { user, profile, isAuthLoading } = useAppStore.getState().auth;

    // A. LOADING
    if (isAuthLoading) {
        // This relies on the global spinner being injected by main.js or uiUtils
        // We just leave the container to be managed by the spinner logic or show a small placeholder
        container.innerHTML = `<div class="auth-loading-spinner" style="width:24px; height:24px;"></div>`;
        return;
    }

    // B. LOGGED IN
    if (user) {
        const role = profile?.role;
        let displayHTML = '';

        if (role === 'god') {
            displayHTML = `<span class="role-badge god" style="background:black; color:white; padding:2px 6px; border-radius:4px; font-size:0.8rem; font-weight:bold;">GOD MODE</span>`;
        } else if (role === 'owner') {
            displayHTML = `<span class="role-badge owner" style="background:var(--primary-color); color:white; padding:2px 6px; border-radius:4px; font-size:0.8rem; font-weight:bold;">OWNER</span>`;
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
    // C. LOGGED OUT
    else {
        container.innerHTML = `
            <button id="login-signup-btn" class="button-primary small" style="font-size:0.8rem; padding: 6px 12px;">Login / Sign Up</button>
        `;
    }
}

// --- 2. LOGIN / SIGNUP MODAL ---
export function showLoginSignupModal() {
    const modalContentHTML = `
        <div class="auth-modal-container">
            <!-- LOGIN SECTION -->
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
            
            <!-- SIGNUP SECTION -->
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

// --- 3. LOGIN LOGIC ---
async function handleLoginFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    const messageEl = document.getElementById('login-message');
    
    const email = form.email.value.trim();
    const password = form.password.value;
    
    // Validation
    if (!isValidEmail(email)) {
        messageEl.textContent = "Please enter a valid email address.";
        messageEl.className = 'auth-message error';
        return;
    }

    // UI Feedback
    const originalBtnText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Logging In...';
    messageEl.textContent = '';
    messageEl.className = 'auth-message';

    try {
        const { login } = useAppStore.getState().auth;
        const result = await login(email, password);
        const error = result.error;

        if (error) {
            // --- Auto-fill Signup Inputs on Failure ---
            const signupEmail = document.getElementById('signup-email');
            const signupPass = document.getElementById('signup-password');
            if (signupEmail) signupEmail.value = email;
            if (signupPass) signupPass.value = password;
            // -----------------------------------------

            let msg = error.message || "Login failed";
            
            // Helpful messages
            if (msg.includes("Invalid login credentials")) {
                msg = "Incorrect email or password.";
            } else if (msg.includes("AuthApiError")) {
                msg = "Login failed. Please check your details.";
            }

            messageEl.textContent = msg;
            messageEl.className = 'auth-message error';
            uiUtils.showToast(msg, 'error');
            
            submitButton.disabled = false;
            submitButton.textContent = originalBtnText;
        } else {
            uiUtils.showToast('Login successful!', 'success');
            uiUtils.closeModal();
        }
    } catch (unexpectedErr) {
        console.error("Login Crash:", unexpectedErr);
        messageEl.textContent = "An unexpected error occurred.";
        messageEl.className = 'auth-message error';
        submitButton.disabled = false;
        submitButton.textContent = originalBtnText;
    }
}

// --- 4. SIGNUP LOGIC ---
async function handleSignupFormSubmit(event) {
    event.preventDefault();
    const form = event.target;
    const submitButton = form.querySelector('button[type="submit"]');
    const messageEl = document.getElementById('signup-message');
    
    const email = form.email.value.trim();
    const password = form.password.value;
    
    // Validation
    if (!isValidEmail(email)) {
        messageEl.textContent = "Please enter a valid email address.";
        messageEl.className = 'auth-message error';
        return;
    }

    if (password.length < 6) {
        messageEl.textContent = "Password must be at least 6 characters.";
        messageEl.className = 'auth-message error';
        return;
    }

    // UI Feedback
    submitButton.disabled = true;
    submitButton.textContent = 'Signing Up...';
    messageEl.textContent = '';
    messageEl.className = 'auth-message';

    try {
        const { signUp } = useAppStore.getState().auth;
        const { error } = await signUp(email, password);

        if (error) {
            let msg = error.message;
            if (msg.includes("Supabase Auth Error")) msg = "Sign up failed. Please try again.";
            
            messageEl.textContent = msg;
            messageEl.className = 'auth-message error';
            submitButton.disabled = false;
            submitButton.textContent = 'Sign Up';
        } else {
            messageEl.textContent = 'Success! You are logged in.';
            messageEl.className = 'auth-message success';
            uiUtils.showToast('Account created!', 'success');
            // Allow auto-login behavior (auth listener handles close)
        }
    } catch (err) {
        console.error("Signup Crash:", err);
        messageEl.textContent = "Sign up failed.";
        submitButton.disabled = false;
        submitButton.textContent = 'Sign Up';
    }
}
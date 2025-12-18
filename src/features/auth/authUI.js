// src/features/auth/authUI.js
import { useAppStore } from '@/store/appStore.js';
import * as uiUtils from '@/utils/uiUtils.js';

// --- HELPERS ---

function isEmail(input) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

// Automatically append dummy domain if it's just a username
function formatLoginString(input) {
    const trimmed = input.trim();
    if (isEmail(trimmed)) return trimmed;
    // It's a username -> Append dummy domain
    return `${trimmed}@mealmates.local`; 
}

// --- 1. AUTH STATUS (Header) ---
export function renderAuthStatus() {
    const container = document.getElementById('auth-status-container');
    if (!container) return;

    const { user, profile, isAuthLoading } = useAppStore.getState().auth;

    if (isAuthLoading) {
        container.innerHTML = `<div class="auth-loading-spinner" style="width:24px; height:24px;"></div>`;
        return;
    }

    if (user) {
        const role = profile?.role;
        let displayHTML = '';

        if (role === 'god') {
            displayHTML = `<span class="role-badge god" style="background:black; color:white; padding:2px 6px; border-radius:4px; font-size:0.8rem; font-weight:bold;">GOD MODE</span>`;
        } else if (role === 'owner') {
            displayHTML = `<span class="role-badge owner" style="background:var(--primary-color); color:white; padding:2px 6px; border-radius:4px; font-size:0.8rem; font-weight:bold;">OWNER</span>`;
        } else {
            // Clean up username display (remove fake domain)
            const rawName = profile?.full_name || user.email.split('@')[0];
            const name = rawName.replace('.local', ''); 
            displayHTML = `<span class="user-greeting" style="font-size:0.9rem;">Hi, ${name}</span>`;
        }

        container.innerHTML = `
            <div class="auth-user-display" style="display:flex; align-items:center; gap:10px;">
                ${displayHTML}
                <button id="logout-btn" class="button-link" style="font-size:0.9rem; text-decoration:underline; cursor:pointer; border:none; background:none; color:var(--text-color);">Logout</button>
            </div>
        `;
    } else {
        container.innerHTML = `
            <button id="login-signup-btn" class="button-primary small" style="font-size:0.8rem; padding: 6px 12px;">Login / Sign Up</button>
        `;
    }
}

// --- 2. LOGIN / SIGNUP MODAL ---
export function showLoginSignupModal() {
    // Retrieve saved username
    const savedInput = localStorage.getItem('last_login_input') || '';

    const modalContentHTML = `
        <div class="auth-modal-container">
            <!-- LOGIN SECTION -->
            <div class="auth-form-section">
                <h2>Login</h2>
                <form id="login-form" novalidate>
                    <div class="form-group">
                        <label for="login-input">Username or Email</label>
                        <!-- FIX: Type is text to allow usernames -->
                        <input type="text" id="login-input" name="identifier" value="${savedInput}" required placeholder="e.g. Steve">
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
                        <label for="signup-input">Username or Email</label>
                        <input type="text" id="signup-input" name="identifier" value="${savedInput}" required placeholder="Pick a username">
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
    
    const rawInput = form.identifier.value.trim();
    const password = form.password.value;
    
    // FIX: Apply domain trick
    const emailPayload = formatLoginString(rawInput);
    
    // Save for convenience
    localStorage.setItem('last_login_input', rawInput);

    // UI Feedback
    const originalBtnText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = 'Logging In...';
    messageEl.textContent = '';
    messageEl.className = 'auth-message';

    try {
        const { login } = useAppStore.getState().auth;
        const result = await login(emailPayload, password);
        const error = result.error;

        if (error) {
            // Auto-fill Signup
            const signupInput = document.getElementById('signup-input');
            const signupPass = document.getElementById('signup-password');
            if (signupInput) signupInput.value = rawInput;
            if (signupPass) signupPass.value = password;

            let msg = error.message || "Login failed";
            if (msg.includes("Invalid login credentials")) msg = "Incorrect username or password.";
            else if (msg.includes("AuthApiError")) msg = "Login failed. Check details.";

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
        messageEl.textContent = "Error occurred.";
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
    
    const rawInput = form.identifier.value.trim();
    const password = form.password.value;
    
    // Validate Length
    if (rawInput.length < 3) {
        messageEl.textContent = "Username must be at least 3 characters.";
        messageEl.className = 'auth-message error';
        return;
    }
    if (password.length < 6) {
        messageEl.textContent = "Password must be at least 6 characters.";
        messageEl.className = 'auth-message error';
        return;
    }

    // FIX: Apply domain trick
    const emailPayload = formatLoginString(rawInput);
    localStorage.setItem('last_login_input', rawInput);

    submitButton.disabled = true;
    submitButton.textContent = 'Signing Up...';
    messageEl.textContent = '';
    messageEl.className = 'auth-message';

    try {
        const { signUp } = useAppStore.getState().auth;
        const { error } = await signUp(emailPayload, password);

        if (error) {
            let msg = error.message;
            if (msg.includes("Supabase Auth Error")) msg = "Sign up failed. Username might be taken.";
            
            messageEl.textContent = msg;
            messageEl.className = 'auth-message error';
            submitButton.disabled = false;
            submitButton.textContent = 'Sign Up';
        } else {
            messageEl.textContent = 'Success! You are logged in.';
            messageEl.className = 'auth-message success';
            uiUtils.showToast('Account created!', 'success');
        }
    } catch (err) {
        messageEl.textContent = "Sign up failed.";
        submitButton.disabled = false;
        submitButton.textContent = 'Sign Up';
    }
}
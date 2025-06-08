// src/auth.js

import { supabase } from './supabaseClient.js'; // Import the initialized Supabase client
import * as api from './apiService.js';         // For fetching user profile with roles
import * as ui from './ui.js';                 // For modal dialogs and UI updates

// Module-scoped variables to hold current user state
let currentUser = null;
let userProfile = null; // To store custom roles like 'owner', 'manager'

// --- Internal Helper Functions ---

function _updateAuthUI(user, profile) {
    const loginButton = document.getElementById('login-button');
    const logoutButton = document.getElementById('logout-button');
    const authStatusSpan = document.getElementById('auth-status');
    const adminLinksSpan = document.getElementById('admin-links');

    if (user) {
        if (loginButton) loginButton.style.display = 'none';
        if (adminLinksSpan) adminLinksSpan.style.display = 'inline';
        if (logoutButton) logoutButton.style.display = 'inline';
        if (authStatusSpan) {
            authStatusSpan.innerHTML = `Logged in as ${user.email}. <small>Role: ${profile?.role || 'customer'}</small>`;
        }

        const ownerDashboardLink = adminLinksSpan?.querySelector('a[href="#owner-dashboard"]');
        const managerDashboardLink = adminLinksSpan?.querySelector('a[href="#manager-dashboard"]');

        if (ownerDashboardLink) {
            ownerDashboardLink.style.display = (profile?.role === 'owner' || profile?.role === 'manager') ? 'inline' : 'none';
        }
        if (managerDashboardLink) {
            managerDashboardLink.style.display = (profile?.role === 'manager') ? 'inline' : 'none';
        }

    } else {
        if (loginButton) loginButton.style.display = 'inline';
        if (adminLinksSpan) adminLinksSpan.style.display = 'none';
        // Ensure logout button is hidden if no user
        if (logoutButton) logoutButton.style.display = 'none';
        if (authStatusSpan) {
            // Recreate login button structure if needed or ensure event listener is attached.
            authStatusSpan.innerHTML = '<button id="login-button">Login/Sign Up</button>';
            const newLoginButton = document.getElementById('login-button'); // Get the newly created button
            if (newLoginButton) {
                newLoginButton.addEventListener('click', showLoginModal); // Re-attach listener
            }
        }
    }
    // Dispatch event for other parts of app to know auth state changed
    document.dispatchEvent(new CustomEvent('authChange', { detail: { user, profile } }));
}

async function _handleAuthForm(event) {
    event.preventDefault();
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const messageEl = document.getElementById('auth-message');

    if (!emailInput || !passwordInput || !messageEl) {
        console.error("Auth form elements not found.");
        return;
    }

    const email = emailInput.value;
    const password = passwordInput.value;
    messageEl.textContent = 'Processing...';

    if (!supabase) {
        messageEl.textContent = 'Auth system not properly initialized.';
        console.error("Supabase client not available in _handleAuthForm");
        return;
    }

    try {
        // Try to sign in
        let { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error && (error.message.includes('Invalid login credentials') || error.message.includes('Email not confirmed'))) {
            // If sign in fails with specific errors, try to sign up
            // Or if email not confirmed, tell them to check email if signUp was already done.
            if(error.message.includes('Email not confirmed')){
                 messageEl.textContent = 'Email not confirmed. Please check your inbox (and spam folder) for a confirmation link.';
                 return; // Don't proceed to signup if confirmation is pending
            }

            ({ data, error } = await supabase.auth.signUp({ email, password }));
            if (!error && data.user) {
                messageEl.textContent = 'Signup successful! Please check your email to confirm.';
                // No need to close modal immediately, let user see message
                // ui.closeModal(); // Or show success message
                // Profile creation is handled by Supabase trigger (handle_new_user)
                return; // Exit after successful signup message
            }
        }

        if (error) throw error; // Rethrow other errors

        if (data.user) {
            messageEl.textContent = 'Login successful!';
            await checkUserSession(); // Refreshes UI and global state (exports currentUser and userProfile)
            if (ui && typeof ui.closeModal === 'function') {
                ui.closeModal();
            }
            // Navigate based on current hash or to menu. Ensure navigateTo is available.
            // if (typeof window.navigateTo === 'function') {
            //     window.navigateTo(window.location.hash || '#menu');
            // }
        } else if (!data.session && !data.user) { // No user, no session, but also no clear error
            messageEl.textContent = 'An unexpected issue occurred. Please try again.';
        }
    } catch (error) {
        console.error("Auth error in _handleAuthForm:", error);
        messageEl.textContent = error.message || 'Authentication failed. Please check your credentials.';
    }
}

async function _handleMagicLink() {
    const emailInput = document.getElementById('email');
    const messageEl = document.getElementById('auth-message');

    if (!emailInput || !messageEl) {
        console.error("Magic link form elements not found.");
        return;
    }
    const email = emailInput.value;
    if (!email) {
        messageEl.textContent = 'Please enter your email address first.';
        return;
    }
    messageEl.textContent = 'Sending link...';

    if (!supabase) {
        messageEl.textContent = 'Auth system not properly initialized.';
        console.error("Supabase client not available in _handleMagicLink");
        return;
    }
    try {
        const { error } = await supabase.auth.signInWithOtp({ email });
        if (error) throw error;
        messageEl.textContent = 'Magic link sent! Check your email.';
    } catch (error) {
        console.error("Magic link error:", error);
        messageEl.textContent = error.message || 'Failed to send magic link.';
    }
}


// --- Exported Functions ---

export async function checkUserSession() {
    if (!supabase) {
        console.error("Supabase client not initialized. Cannot check user session.");
        _updateAuthUI(null, null); // Update UI to logged-out state
        return { user: null, profile: null };
    }

    try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
            console.error("Error getting session:", sessionError);
            _updateAuthUI(null, null);
            return { user: null, profile: null };
        }

        currentUser = session?.user || null;

        if (currentUser) {
            try {
                // Ensure api.getUserProfile is an exported async function from apiService.js
                userProfile = await api.getUserProfile();
            } catch (profileError) {
                console.warn("Failed to fetch user profile for logged-in user:", profileError.message);
                // Default to 'customer' role if profile fetch fails but user is authenticated
                userProfile = { role: 'customer', id: currentUser.id, email: currentUser.email };
            }
        } else {
            userProfile = null;
        }
    } catch (e) {
        console.error("Unexpected error in checkUserSession:", e);
        currentUser = null;
        userProfile = null;
    }

    _updateAuthUI(currentUser, userProfile);
    return { user: currentUser, profile: userProfile };
}

export function showLoginModal() {
    const modalBodyContent = `
        <h2>Login / Sign Up</h2>
        <form id="auth-form">
            <div>
                <label for="email">Email:</label>
                <input type="email" id="email" name="email" required>
            </div>
            <div>
                <label for="password">Password:</label>
                <input type="password" id="password" name="password" required>
            </div>
            <button type="submit">Login / Sign Up</button>
            <p id="auth-message" style="margin-top: 10px; color: red;"></p>
        </form>
        <button id="magic-link-button" style="margin-top: 10px;">Send Magic Link</button>
    `;

    // Ensure ui.showModal is correctly imported and available
    if (ui && typeof ui.showModal === 'function') {
        ui.showModal(modalBodyContent);

        // Attach event listeners after modal content is in the DOM
        const authForm = document.getElementById('auth-form');
        const magicLinkButton = document.getElementById('magic-link-button');

        if (authForm) {
            authForm.addEventListener('submit', _handleAuthForm);
        } else {
            console.error("Auth form not found in modal to attach listener.");
        }
        if (magicLinkButton) {
            magicLinkButton.addEventListener('click', _handleMagicLink);
        } else {
            console.error("Magic link button not found in modal to attach listener.");
        }
    } else {
        console.error("ui.showModal is not available. Cannot show login modal.");
        alert("Login/Signup UI cannot be displayed at the moment."); // Fallback
    }
}

export async function handleLogout() {
    if (!supabase) {
        console.error("Supabase client not initialized. Cannot logout.");
        return;
    }
    try {
        const { error } = await supabase.auth.signOut();
        if (error) {
            console.error("Logout error:", error);
        }
        // Auth state change listener below will handle UI updates and clearing user state.
        // navigateTo might be called by the auth state listener
    } catch (e) {
        console.error("Unexpected error during logout:", e);
    }
}

export function getCurrentUser() {
    return { user: currentUser, profile: userProfile };
}

// --- Supabase Auth State Change Listener ---
// This should be set up once when the auth module is initialized (e.g., when main.js imports it)

if (supabase) {
    supabase.auth.onAuthStateChange(async (event, session) => {
        console.log('Auth state changed:', event, session?.user?.id);
        // We call checkUserSession which will re-fetch profile and update UI
        // This ensures profile is also up-to-date after login/logout.
        await checkUserSession();

        if (event === 'SIGNED_OUT') {
            // Additional actions on sign out if needed
            // For example, if cart is managed in a different module:
            // if (typeof window.cart !== 'undefined' && typeof window.cart.clearCart === 'function') {
            //     window.cart.clearCart();
            // }
            // Ensure navigateTo is available
            if (typeof window.navigateTo === 'function') {
                window.navigateTo('#menu');
            }
        } else if (event === 'SIGNED_IN') {
             if (typeof window.navigateTo === 'function') {
                const currentHash = window.location.hash;
                // If on checkout page and login was required, stay or proceed.
                // Otherwise, can navigate to a default like #menu or user dashboard.
                if (currentHash !== '#checkout') { // Example logic
                   // window.navigateTo('#menu');
                } else {
                   // if login was for checkout, let checkout logic handle next step.
                   // The 'authChange' event dispatched by _updateAuthUI can be used by checkout page.
                }
            }
        }
    });
} else {
    // This case might occur if supabaseClient.js fails to initialize Supabase
    // for example, due to missing ENV VARS.
    console.error("Supabase client not available in auth.js for onAuthStateChange listener. Auth will not function correctly.");
    // Display a more prominent error to the user or on the page?
    // This is a critical failure.
    document.addEventListener('DOMContentLoaded', () => { // Ensure DOM is ready for this
        const authStatus = document.getElementById('auth-status');
        if (authStatus) {
            authStatus.innerHTML = '<span style="color:red; font-weight:bold;">Authentication System Error!</span>';
        }
    });
}
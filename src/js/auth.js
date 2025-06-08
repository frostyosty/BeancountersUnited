// auth.js
const loginButton = document.getElementById('login-button');
const logoutButton = document.getElementById('logout-button');
const authStatusSpan = document.getElementById('auth-status');
const adminLinksSpan = document.getElementById('admin-links');
let currentUser = null;
let userProfile = null; // To store custom roles like 'owner', 'manager'

async function checkUserSession() {
    if (!supabase) {
        updateAuthUI(null);
        return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    currentUser = session?.user || null;
    
    if (currentUser) {
        try {
            userProfile = await api.getUserProfile(); // Fetch profile with role
        } catch (error) {
            console.error("Failed to fetch user profile:", error);
            // If profile fetch fails, user might exist in auth but not in profiles table (e.g. signup interrupted)
            // Treat as logged in but without special roles for now.
            userProfile = { role: 'customer' }; // Default role
        }
    } else {
        userProfile = null;
    }
    updateAuthUI(currentUser, userProfile);
    return { user: currentUser, profile: userProfile };
}

function updateAuthUI(user, profile) {
    if (user) {
        loginButton.style.display = 'none';
        adminLinksSpan.style.display = 'inline'; // Show admin links container
        logoutButton.style.display = 'inline';   // Show logout button
        authStatusSpan.innerHTML = `Logged in as ${user.email}. Role: ${profile?.role || 'customer'}`;

        // Toggle visibility of admin/manager links based on role
        const ownerDashboardLink = adminLinksSpan.querySelector('a[href="#owner-dashboard"]');
        const managerDashboardLink = adminLinksSpan.querySelector('a[href="#manager-dashboard"]');

        if (ownerDashboardLink) ownerDashboardLink.style.display = (profile?.role === 'owner' || profile?.role === 'manager') ? 'inline' : 'none';
        if (managerDashboardLink) managerDashboardLink.style.display = (profile?.role === 'manager') ? 'inline' : 'none';

    } else {
        loginButton.style.display = 'inline';
        adminLinksSpan.style.display = 'none';
        authStatusSpan.innerHTML = '<button id="login-button">Login/Sign Up</button>';
        // Re-attach event listener if login button is recreated
        document.getElementById('login-button')?.addEventListener('click', showLoginModal);
    }
    // Dispatch event for other parts of app to know auth state changed
    document.dispatchEvent(new CustomEvent('authChange', { detail: { user, profile } }));
}

function showLoginModal() {
    const modalBody = `
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
            <p id="auth-message"></p>
        </form>
        <button id="magic-link-button">Send Magic Link</button>
    `;
    ui.showModal(modalBody);
    document.getElementById('auth-form').addEventListener('submit', handleAuthForm);
    document.getElementById('magic-link-button').addEventListener('click', handleMagicLink);
}

async function handleAuthForm(event) {
    event.preventDefault();
    const email = event.target.email.value;
    const password = event.target.password.value;
    const messageEl = document.getElementById('auth-message');
    messageEl.textContent = 'Processing...';

    if (!supabase) {
        messageEl.textContent = 'Auth system not configured.';
        return;
    }

    try {
        // Try to sign in
        let { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error && error.message.includes('Invalid login credentials')) {
            // If sign in fails, try to sign up
            ({ data, error } = await supabase.auth.signUp({ email, password }));
             if (!error && data.user) {
                // IMPORTANT: New user signed up. Now create a profile in your `profiles` table.
                // This usually happens in a trigger in Supabase, or you make an API call here.
                // For simplicity, we'll assume a trigger creates a 'customer' profile.
                messageEl.textContent = 'Signup successful! Please check your email to confirm.';
                ui.closeModal(); // Or show success message
            }
        }
        
        if (error) throw error;

        if (data.user) {
            messageEl.textContent = 'Login successful!';
            await checkUserSession(); // Refreshes UI and global state
            ui.closeModal();
            navigateTo(window.location.hash || '#menu'); // Refresh current page or go to menu
        } else {
            messageEl.textContent = 'An unexpected error occurred.';
        }
    } catch (error) {
        console.error("Auth error:", error);
        messageEl.textContent = error.message || 'Authentication failed.';
    }
}

async function handleMagicLink() {
    const email = document.getElementById('email')?.value;
    const messageEl = document.getElementById('auth-message');
    if (!email) {
        messageEl.textContent = 'Please enter your email address first.';
        return;
    }
    messageEl.textContent = 'Sending link...';
     if (!supabase) {
        messageEl.textContent = 'Auth system not configured.';
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

async function handleLogout() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) {
        console.error("Logout error:", error);
    } else {
        currentUser = null;
        userProfile = null;
        updateAuthUI(null);
        cart.clearCart(); // Clear cart on logout if desired
        navigateTo('#menu'); // Go to menu page
    }
}


// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    // Initial check, might be overridden by main.js ensuring supabase is init first
    // setTimeout(checkUserSession, 100); // Delay slightly to ensure supabase client is ready
    
    // This listener relies on the elements being present from index.html
    // If they are dynamically added, listeners need to be added then or use event delegation
    loginButton?.addEventListener('click', showLoginModal);
    logoutButton?.addEventListener('click', handleLogout);
});

// Handle auth state changes from Supabase (e.g., magic link, OAuth)
supabase?.auth.onAuthStateChange((event, session) => {
    console.log('Auth state changed:', event, session);
    if (event === 'SIGNED_IN' || event === 'USER_UPDATED' || event === 'TOKEN_REFRESHED') {
        currentUser = session.user;
        checkUserSession(); // Fetch profile and update UI
    } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        userProfile = null;
        updateAuthUI(null, null);
        cart.clearCart(); // Example: Clear cart on logout
        navigateTo('#menu');
    }
});


// Expose functions to global scope or use modules
window.auth = {
    checkUserSession,
    getCurrentUser: () => ({ user: currentUser, profile: userProfile }),
    showLoginModal,
    handleLogout,
    // ... other functions you might want to expose
};
// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js'; // To fetch the user's profile with role

/**
 * Creates a Zustand slice for managing authentication state.
 *
 * @param {Function} set - Zustand's state setter function.
 * @param {Function} get - Zustand's state getter function.
 * @returns {object} The auth slice of the store.
 */
export const createAuthSlice = (set, get) => ({
    // --- STATE ---
    user: null,           // The user object from Supabase Auth
    profile: null,        // The user's profile from our 'profiles' table (contains the role)
    isLoading: true,      // True during initial session check
    isAuthenticated: false, // A convenient flag derived from the user object

    // --- ACTIONS ---

    /**
     * Checks for an active session on app startup and sets up the auth listener.
     */
    initializeAuth: () => {
        // --- 1. Set up the onAuthStateChange listener ---
        // This is the most important part. It reacts to logins, logouts, etc. in real-time.
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`Auth event: ${event}`);
            if (session?.user) {
                // User is logged in. Fetch their profile to get their role.
                try {
                    const profile = await api.getUserProfile();
                    set({ user: session.user, profile: profile, isAuthenticated: true, isLoading: false }, false, 'auth/session-restored');
                } catch (error) {
                    console.error("Failed to fetch profile for logged-in user:", error);
                    // Set user but profile is null, handle this gracefully in the UI
                    set({ user: session.user, profile: null, isAuthenticated: true, isLoading: false }, false, 'auth/profile-fetch-error');
                }
            } else {
                // User is logged out or session expired.
                set({ user: null, profile: null, isAuthenticated: false, isLoading: false }, false, 'auth/no-session');
            }
        });

        // --- 2. Perform an initial session check ---
        // This resolves the initial `isLoading: true` state.
        // The onAuthStateChange listener above will handle the result.
        // We wrap this in a function to be called from main.js
        const checkInitialSession = async () => {
            // getSession() will trigger the onAuthStateChange listener we just set up.
            // If there's a session, the listener will fire with 'SIGNED_IN' or 'INITIAL_SESSION'.
            // If not, it will fire with 'SIGNED_OUT'.
            const { error } = await supabase.auth.getSession();
            if (error) {
                console.error("Error during initial getSession():", error);
                set({ isLoading: false }, false, 'auth/init-error');
            }
        };
        checkInitialSession();
    },

    /**
     * Signs up a new user.
     * @param {string} email - The user's email.
     * @param {string} password - The user's password.
     * @returns {Promise<{error: object|null}>} - An object containing a potential error.
     */
    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) console.error('Sign up error:', error);
        return { error };
    },

    /**
     * Logs in an existing user.
     * @param {string} email - The user's email.
     * @param {string} password - The user's password.
     * @returns {Promise<{error: object|null}>} - An object containing a potential error.
     */
    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) console.error('Login error:', error);
        // The onAuthStateChange listener will handle updating the state on success.
        return { error };
    },

    /**
     * Logs the user out.
     * @returns {Promise<{error: object|null}>} - An object containing a potential error.
     */
    logout: async () => {
        const { error } = await supabase.auth.signOut();
        if (error) console.error('Logout error:', error);
        // The onAuthStateChange listener will handle updating the state.
        return { error };
    },

    // --- SELECTORS ---
    /**
     * A selector to easily get the user's role.
     * @returns {string} - The user's role ('manager', 'owner', 'customer', or 'guest').
     */
    getUserRole: () => {
        return get().profile?.role || 'guest';
    },
});
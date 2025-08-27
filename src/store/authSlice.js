// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // --- STATE ---
    user: null,
    profile: null,
    isLoading: true,
    isAuthenticated: false,
    // --- NEW STATE FOR IMPERSONATION ---
    originalUser: null,    // Stores the real user object during impersonation
    originalProfile: null, // Stores the real profile object (with 'manager' role)
    // --- ACTIONS ---

    initializeAuth: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`Auth event: ${event}`);

            // If we are impersonating, don't let the real auth state override it.
            if (get().originalUser) {
                return;
            }

            if (session?.user) {
                try {
                    const profile = await api.getUserProfile();
                    set({ user: session.user, profile: profile, isAuthenticated: true, isLoading: false }, false, 'auth/session-restored');
                } catch (error) {
                    console.error("Failed to fetch profile for logged-in user:", error);
                    set({ user: session.user, profile: null, isAuthenticated: true, isLoading: false }, false, 'auth/profile-fetch-error');
                }
            } else {
                set({ user: null, profile: null, isAuthenticated: false, isLoading: false }, false, 'auth/no-session');
            }
        });

        const checkInitialSession = async () => {
            await supabase.auth.getSession();
        };
        checkInitialSession();
    },

    // ... (keep signUp, login, logout actions as they are) ...
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

    logout: async () => {
        // --- UPDATE LOGOUT TO HANDLE IMPERSONATION ---
        // If we're impersonating, logout should just stop impersonating.
        if (get().originalUser) {
            get().stopImpersonating();
            return { error: null };
        }
        const { error } = await supabase.auth.signOut();
        if (error) console.error('Logout error:', error);
        return { error };
    },

    // --- NEW ACTIONS FOR IMPERSONATION ---

    /**
     * Allows a manager to impersonate a different role.
     * @param {'owner' | 'customer' | 'guest'} roleToImpersonate - The role to switch to.
     */
    impersonateRole: (roleToImpersonate) => {
        const { user, profile, originalUser } = get();

        // Only allow impersonation if the real user is a manager and not already impersonating.
        if (profile?.role !== 'manager' || originalUser) {
            return;
        }

        let impersonatedUser = user;
        let impersonatedProfile = { ...profile, role: roleToImpersonate };

        if (roleToImpersonate === 'guest') {
            impersonatedUser = null;
            impersonatedProfile = null;
        }

        set({
            // Store the real user and profile
            originalUser: user,
            originalProfile: profile,
            // Overwrite the current user and profile with the fake ones
            user: impersonatedUser,
            profile: impersonatedProfile,
            isAuthenticated: roleToImpersonate !== 'guest',
        }, false, `auth/impersonate-${roleToImpersonate}`);
    },

    /**
     * Stops impersonation and restores the original manager session.
     */
    stopImpersonating: () => {
        const { originalUser, originalProfile } = get();
        if (!originalUser) return; // Not impersonating

        set({
            // Restore the real user and profile
            user: originalUser,
            profile: originalProfile,
            isAuthenticated: true,
            // Clear the impersonation state
            originalUser: null,
            originalProfile: null,
        }, false, 'auth/stop-impersonating');
    },


    // --- SELECTORS ---
    getUserRole: () => {
        return get().profile?.role || 'guest';
    },

    // --- NEW SELECTOR FOR IMPERSONATION ---
    /**
     * @returns {boolean} - True if currently impersonating another role.
     */
    isImpersonating: () => {
        return !!get().originalUser;
    },
});

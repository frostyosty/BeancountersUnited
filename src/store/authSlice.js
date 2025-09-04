// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    /**
     * This is the state for the authentication slice.
     * It includes properties for the current user, their profile,
     * loading status, and the state needed for god mode impersonation.
     */
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,
    originalUser: null,
    originalProfile: null,

    /**
     * This is the main listener for Supabase auth events. It handles all
     * session updates (login, logout, token refresh, initial state).
     */
    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            // This check now works because isImpersonating() is defined below.
            if (get().auth.isImpersonating()) {
                return; // Do not process real auth events while impersonating
            }

            if (session?.user) {
                try {
                    const profile = await api.getUserProfile(session.access_token);
                    set(state => ({ auth: { ...state.auth, user: session.user, profile, isAuthenticated: true, isAuthLoading: false } }));
                } catch (error) {
                    console.error("Failed to fetch profile:", error);
                    set(state => ({ auth: { ...state.auth, user: session.user, profile: null, isAuthenticated: true, isAuthLoading: false, authError: "Failed to fetch profile" } }));
                }
            } else {
                set(state => ({ auth: { ...state.auth, user: null, profile: null, isAuthenticated: false, isAuthLoading: false } }));
            }
        });
    },

    /**
     * Signs up a new user.
     */
    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        return { error };
    },

    /**
     * Logs in an existing user.
     */
    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error };
    },

    /**
     * Logs out the current user or stops impersonating.
     */
    logout: async () => {
        if (get().auth.isImpersonating()) {
            get().auth.stopImpersonating();
            return { error: null };
        }
        await supabase.auth.signOut();
        return { error: null };
    },

    /**

     * --- GOD MODE FEATURE ---
     * This is the "View Site As" functionality for the god user.
     * It allows a manager to temporarily take on the role of another user type.
     */
    impersonateRole: (roleToImpersonate) => {
        const { user, profile, originalUser } = get().auth;
        if (profile?.role !== 'manager' || originalUser) return;

        let impersonatedUser = user;
        let impersonatedProfile = { ...profile, role: roleToImpersonate };

        if (roleToImpersonate === 'guest') {
            impersonatedUser = null;
            impersonatedProfile = null;
        }

        set(state => ({
            auth: { ...state.auth, originalUser: user, originalProfile: profile, user: impersonatedUser, profile: impersonatedProfile, isAuthenticated: roleToImpersonate !== 'guest' }
        }), false, `auth/impersonate-${roleToImpersonate}`);
    },

    /**
     * --- GOD MODE FEATURE ---
     * Restores the god user's original session after impersonating.
     */
    stopImpersonating: () => {
        const { originalUser, originalProfile } = get();
        if (!originalUser) return;

        set(state => ({
            auth: { ...state.auth, user: originalUser, profile: originalProfile, isAuthenticated: true, originalUser: null, originalProfile: null }
        }), false, 'auth/stop-impersonating');
    },

    /**
     * --- SELECTORS ---
     * Gets the currently displayed role (real or impersonated).
     */
    getUserRole: () => {
        return get().auth.profile?.role || 'guest';
    },

    /**
     * --- SELECTOR (THE MISSING FUNCTION) ---
     * Checks if impersonation is currently active.
     */
    isImpersonating: () => {
        return !!get().auth.originalUser;
    },
});
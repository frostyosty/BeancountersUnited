// src/store/authSlice.js - VERBOSE DEBUGGING
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // ... (State properties are fine)
    user: null, profile: null, isAuthLoading: true, isAuthenticated: false,
    authError: null, originalUser: null, originalProfile: null,

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`--- [authSlice] Auth event received: ${event} ---`);
            
            if (get().auth.isImpersonating()) {
                console.log("[authSlice] Impersonating, ignoring event.");
                return;
            }

            if (session?.user) {
                console.log(`[authSlice] Session found for user ${session.user.id}. Attempting to fetch profile...`);
                try {
                    const profile = await api.getUserProfile(session.access_token);
                    console.log("[authSlice] Profile fetched successfully:", profile);
                    set(state => ({ auth: { ...state.auth, user: session.user, profile, isAuthenticated: true, isAuthLoading: false } }));
                } catch (error) {
                    console.error("[authSlice] FAILED to fetch profile:", error);
                    set(state => ({ auth: { ...state.auth, user: session.user, profile: null, isAuthenticated: true, isAuthLoading: false, authError: error.message } }));
                }
            } else {
                console.log("[authSlice] No session found. Setting user to null.");
                set(state => ({ auth: { ...state.auth, user: null, profile: null, isAuthenticated: false, isAuthLoading: false } }));
            }
        });
    },

    /**
     * Logs in an existing user.
     */
 login: async (email, password) => {
        try {
            // --- THE FIX ---
            // Call our own backend API instead of the Supabase client directly.
            const { session, user } = await api.login(email, password);

            if (session) {
                // If our API returns a session, manually set it in the client.
                // This will trigger the onAuthStateChange listener and log the user in.
                const { error } = await supabase.auth.setSession({
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                });
                if (error) {
                    // Handle the unlikely event that setSession fails
                    console.error("Failed to set session on client:", error);
                    return { error };
                }
                // Return no error on success. The listener will handle the rest.
                return { error: null };
            } else {
                return { error: { message: 'Invalid login credentials.' } };
            }
        } catch (error) {
            // This catches network errors or 401/500 errors from our own API.
            console.error('Login action failed:', error);
            return { error };
        }
    },
    /**
     * Signs up a new user.
     */
    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
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
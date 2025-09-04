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
        console.log(`--- [authSlice] login() action CALLED for email: ${email} ---`);
        if (!email || !password) {
            console.error("[authSlice] Login failed: Email or password is missing.");
            return { error: { message: "Email and password are required." } };
        }
        
        console.log("[authSlice] Calling supabase.auth.signInWithPassword...");
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });

        if (error) {
            console.error("[authSlice] supabase.auth.signInWithPassword returned an ERROR:", error);
        } else {
            console.log("[authSlice] supabase.auth.signInWithPassword was SUCCESSFUL. Data:", data);
        }
        // The onAuthStateChange listener will handle the successful state change.
        return { error };
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
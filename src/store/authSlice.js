// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // --- STATE ---
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,
    // --- Impersonation State ---
    originalUser: null,
    originalProfile: null,

    // --- ACTIONS ---

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            // Use the selector to check if we are impersonating.
            // if (get().auth.isImpersonating()) {
            //     console.log("Impersonating, ignoring auth state change event.");
            //     return;
            // }
            console.log("authSlice: Impersonation check temporarily disabled for debugging.");
            if (session?.user) {
                try {
                    const profile = await api.getUserProfile(session.access_token);
                    set(state => ({ auth: { ...state.auth, user: session.user, profile, isAuthenticated: true, isAuthLoading: false } }));
                } catch (error) {
                    set(state => ({ auth: { ...state.auth, user: session.user, profile: null, isAuthenticated: true, isAuthLoading: false, authError: error.message } }));
                }
            } else {
                set(state => ({ auth: { ...state.auth, user: null, profile: null, isAuthenticated: false, isAuthLoading: false } }));
            }
        });
    },

    // Signs up a new user.
    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        return { error };
    },

    // Logs in an existing user.
    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error }; // The listener will handle the successful state change
    },

     logout: async () => {
        // If impersonating, logout just stops impersonating.
        if (get().auth.isImpersonating()) {
            get().auth.stopImpersonating();
            return { error: null };
        }
        await supabase.auth.signOut();
        return { error: null };
    },

    // --- Impersonation Actions (THE MISSING PIECES) ---

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

    stopImpersonating: () => {
        const { originalUser, originalProfile } = get();
        if (!originalUser) return;

        set(state => ({
            auth: { ...state.auth, user: originalUser, profile: originalProfile, isAuthenticated: true, originalUser: null, originalProfile: null }
        }), false, 'auth/stop-impersonating');
    },

    // --- SELECTORS ---
    getUserRole: () => {
        return get().auth.profile?.role || 'guest';
    },

    // The missing selector function
    isImpersonating: () => {
        return !!get().auth.originalUser;
    },
});
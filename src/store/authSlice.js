import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // State
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,
    originalUser: null,
    originalProfile: null,

    // --- NEW ACTION ---
    // Explicitly sets the user and profile, similar to your reference project.
    setUserAndProfile: (user, profile) => {
        set({
            auth: {
                ...get().auth,
                user,
                profile,
                isAuthenticated: !!user,
                isAuthLoading: false, // Turn off loading
                authError: null
            }
        }, false, 'auth/setUserAndProfile');
    },

     listenToAuthChanges: () => {
        console.log("[AuthSlice] Setting up onAuthStateChange listener.");
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`[AuthSlice] onAuthStateChange event: ${event}`);

            if (get().auth.isImpersonating()) return;

            // This primarily handles LOGOUT and INITIAL_SESSION
            if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
                get().auth.setUserAndProfile(null, null);
            } else if (session?.user) {
                try {
                    const profile = await api.getUserProfile();
                    get().auth.setUserAndProfile(session.user, profile);
                } catch (error) {
                    // Still set the user, but with a null profile and an error
                    get().auth.setUserAndProfile(session.user, null);
                    set(state => ({ auth: { ...state.auth, authError: error.message }}));
                }
            } else {
                // --- THIS IS THE FIX for the initial "..." bug ---
                // This handles the INITIAL_SESSION when no user is found.
                // It ensures isAuthLoading is set to false.
                get().auth.setUserAndProfile(null, null);
            }
        });
    },

    signUp: async (email, password) => {
        return await api.signUpViaApi(email, password);
    },

    // --- UPDATED LOGIN ACTION ---
    login: async (email, password) => {
        try {
            const { session } = await api.loginViaApi(email, password);
            if (session) {
                // After setting the session, we MUST fetch the profile to return it.
                const profile = await api.getUserProfile();
                return { error: null, user: session.user, profile }; // Return all data
            }
            return { error: { message: "Login failed." } };
        } catch (error) {
            return { error };
        }
    },
    
    logout: async () => {
        if (get().auth.isImpersonating()) {
            get().auth.stopImpersonating();
            return;
        }
        await supabase.auth.signOut();
    },

    // --- IMPERSONATION ACTIONS ---
    impersonateRole: (roleToImpersonate) => {
        const { user, profile, isImpersonating } = get().auth;
        // Security check: only a real manager who isn't already impersonating can start.
        const realRole = get().auth.originalProfile?.role || profile?.role;
        if (realRole !== 'manager' || isImpersonating()) return;

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
        const { originalUser, originalProfile } = get().auth;
        if (!originalUser) return;
        set(state => ({
            auth: { ...state.auth, user: originalUser, profile: originalProfile, isAuthenticated: true, originalUser: null, originalProfile: null }
        }), false, 'auth/stop-impersonating');
    },

    // --- SELECTORS ---
    getUserRole: () => get().auth.profile?.role || 'guest',
    isImpersonating: () => !!get().auth.originalUser,
});
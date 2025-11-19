// src/store/authSlice.js
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

    setUserAndProfile: (user, profile) => {
        set({
            auth: {
                ...get().auth,
                user,
                profile,
                isAuthenticated: !!user,
                isAuthLoading: false,
                authError: null
            }
        }, false, 'auth/setUserAndProfile');
    },

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            if (get().auth.isImpersonating()) return;

            if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
                get().auth.setUserAndProfile(null, null);
            } else if (session?.user) {
                try {
                    const token = session.access_token;
                    const profile = await api.getUserProfile(token);
                    get().auth.setUserAndProfile(session.user, profile);

                    // --- NEW: Auto-Redirect for Owners ---
                    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
                        const role = profile?.role;
                        if (role === 'owner' || role === 'manager') {
                            console.log("[AuthSlice] Owner detected. Redirecting to Order History.");
                            window.location.hash = '#order-history';
                        }
                    }
                    // -------------------------------------

                } catch (error) {
                    console.error("[AuthSlice] Profile fetch FAILED.", error);
                    get().auth.setUserAndProfile(session.user, null);
                    set(state => ({ auth: { ...state.auth, authError: error.message } }));
                }
            } else {
                get().auth.setUserAndProfile(null, null);
            }
        });
    },

    login: async (email, password) => {
        try {
            const { session } = await api.loginViaApi(email, password);
            if (session) {
                const { error } = await supabase.auth.setSession({
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                });
                if (error) return { error };
                return { error: null };
            }
            return { error: { message: "Login failed." } };
        } catch (error) {
            return { error };
        }
    },

    signUp: async (email, password) => {
        return await api.signUpViaApi(email, password);
    },

    logout: async () => {
        if (get().auth.isImpersonating()) {
            get().auth.stopImpersonating();
            return;
        }
        await supabase.auth.signOut();
    },

    impersonateRole: (roleToImpersonate) => {
        const { user, profile, isImpersonating } = get().auth;
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

    getUserRole: () => get().auth.profile?.role || 'guest',
    isImpersonating: () => !!get().auth.originalUser,
});
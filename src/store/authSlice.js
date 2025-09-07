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

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            // If we are impersonating, ignore real-time auth events.
            if (get().auth.isImpersonating()) return;

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

    signUp: async (email, password) => {
        return await api.signUpViaApi(email, password);
    },
    login: async (email, password) => {
        try {
            const { session } = await api.loginViaApi(email, password);
            if (session) {
                await supabase.auth.setSession({
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                });
                return { error: null };
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
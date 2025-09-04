// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,
    originalUser: null,
    originalProfile: null,

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
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
        const { error } = await supabase.auth.signUp({ email, password });
        return { error };
    },

    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error }; // The listener handles success
    },

    logout: async () => {
        if (get().auth.isImpersonating()) {
            get().auth.stopImpersonating();
            return { error: null };
        }
        await supabase.auth.signOut();
        return { error: null };
    },

    // --- Impersonation Actions ---
    impersonateRole: (roleToImpersonate) => {
        const { user, profile, originalUser } = get().auth;
        if (profile?.role !== 'manager' || originalUser) return;
        let impersonatedUser = user;
        let impersonatedProfile = { ...profile, role: roleToImpersonate };
        if (roleToImpersonate === 'guest') {
            impersonatedUser = null;
            impersonatedProfile = null;
        }
        set(state => ({ auth: { ...state.auth, originalUser: user, originalProfile: profile, user: impersonatedUser, profile: impersonatedProfile, isAuthenticated: roleToImpersonate !== 'guest' } }));
    },

    stopImpersonating: () => {
        const { originalUser, originalProfile } = get().auth;
        if (!originalUser) return;
        set(state => ({ auth: { ...state.auth, user: originalUser, profile: originalProfile, isAuthenticated: true, originalUser: null, originalProfile: null } }));
    },

    // --- Selectors ---
    getUserRole: () => get().auth.profile?.role || 'guest',
    isImpersonating: () => !!get().auth.originalUser,
});
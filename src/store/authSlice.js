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
        return await api.signUpViaApi(email, password);
    },

    login: async (email, password) => {
        try {
            // Call our own backend API
            const { session, user } = await api.loginViaApi(email, password);

            if (session) {
                // If our API returns a session, manually set it in the client.
                // This will trigger the onAuthStateChange listener and log the user in.
                const { error } = await supabase.auth.setSession({
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                });
                if (error) return { error };
                return { error: null }; // Success
            }
            return { error: { message: "Login failed." } };
        } catch (error) {
            return { error };
        }
    },

    logout: async () => {
        return await supabase.auth.signOut();
    },

    getUserRole: () => get().profile?.role || 'guest',
});
// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // State
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,

    // Actions
    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            if (session?.user) {
                try {
                    const profile = await api.getUserProfile(session.access_token);
                    set(state => ({ auth: { ...state.auth, user: session.user, profile, isAuthenticated: true, isAuthLoading: false } }));
                } catch (error) {
                    set(state => ({ auth: { ...state.auth, user: session.user, profile: null, isAuthenticated: true, isAuthLoading: false } }));
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

    // --- THIS IS THE CRUCIAL SELECTOR ---
    getUserRole: () => {
        // It must get the state from the correct namespace
        return get().auth.profile?.role || 'guest';
    }
});
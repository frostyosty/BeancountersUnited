// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // State properties for auth
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,
    // We will add impersonation state back later

    // Action to set up the auth listener
    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`Auth event: ${event}`);
            if (session?.user) {
                try {
                    const profile = await api.getUserProfile();
                    set({ user: session.user, profile, isAuthenticated: true, isAuthLoading: false });
                } catch (error) {
                    console.error("Failed to fetch profile:", error);
                    set({ user: session.user, profile: null, isAuthenticated: true, isAuthLoading: false, authError: "Failed to fetch profile" });
                }
            } else {
                set({ user: null, profile: null, isAuthenticated: false, isAuthLoading: false });
            }
        });
    },

    // Actions for login/signup/logout
    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error }; // The listener handles the state change on success
    },
    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        return { error };
    },
    logout: async () => {
        const { error } = await supabase.auth.signOut();
        return { error };
    },
    getUserRole: () => {
        return get().profile?.role || 'guest';
    },
});
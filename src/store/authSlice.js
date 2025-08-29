// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // State properties are at the top level
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,
    // We will re-add impersonation later, let's get the core working first

    // This is the ONLY initialization function needed.
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
                // No session, user is logged out.
                set({ user: null, profile: null, isAuthenticated: false, isAuthLoading: false });
            }
        });
    },

    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) console.error('Login error:', error);
        return { error }; // The listener will handle the state change
    },

    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) console.error('Sign up error:', error);
        return { error };
    },

    logout: async () => {
        const { error } = await supabase.auth.signOut();
        if (error) console.error('Logout error:', error);
        return { error };
    },

    getUserRole: () => {
        return get().profile?.role || 'guest';
    },
});
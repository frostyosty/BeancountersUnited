// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`Auth Event in Slice: ${event}`);
            if (session?.user) {
                try {
                    console.log("Attempting to call api.getUserProfile()...");
                    const profile = await api.getUserProfile();
                    console.log("Successfully fetched profile:", profile);
                    set({ user: session.user, profile, isAuthenticated: true, isAuthLoading: false });
                } catch (error) {
                    console.error("Failed to fetch profile in slice:", error);
                    set({ user: session.user, profile: null, isAuthenticated: true, isAuthLoading: false });
                }
            } else {
                set({ user: null, profile: null, isAuthenticated: false, isAuthLoading: false });
            }
        });
    },
    

    // --- The rest of the actions use the simple `set` pattern too ---
    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error }; // The listener above will handle the state change on success
    },

    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        return { error };
    },

    logout: async () => {
        const { error } = await supabase.auth.signOut();
        return { error }; // Listener handles the state change
    },

    getUserRole: () => {
        return get().profile?.role || 'guest';
    },
});
// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // State properties for auth
    user: null,
    profile: null,
    isAuthLoading: true, // Start in a loading state
    isAuthenticated: false,
    authError: null,
    // We'll add impersonation back later

    // This is the ONLY initialization function needed.
    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`Auth event: ${event}`);
            if (session?.user) {
                try {
                    const profile = await api.getUserProfile();
                    // --- CORRECT, FLAT set() CALL ---
                    set({ user: session.user, profile, isAuthenticated: true, isAuthLoading: false });
                } catch (error) {
                    console.error("Failed to fetch profile:", error);
                    set({ user: session.user, profile: null, isAuthenticated: true, isAuthLoading: false, authError: "Failed to fetch profile" });
                }
            } else {
                // --- CORRECT, FLAT set() CALL ---
                // No session, user is logged out.
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
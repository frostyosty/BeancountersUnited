// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`Auth event: ${event}`);
            if (session?.user) {
                try {
                    // --- THE FIX ---
                    // We get the token from the session object that the listener provides.
                    // We DO NOT call getSession() again.
                    const token = session.access_token;
                    const profile = await api.getUserProfile(token); // Pass the token to the API service.
                    
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

    // ... The rest of the slice (login, logout, etc.) is fine.
});
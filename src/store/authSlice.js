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

    // Action to set up the auth listener
    listenToAuthChanges: () => {
        console.log("--- authSlice: Attaching onAuthStateChange listener ---");
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`--- authSlice: onAuthStateChange event received: ${event} ---`);
            
            if (session?.user) {
                console.log(`authSlice: Session found for user ${session.user.id}. Fetching profile...`);
                try {
                    const profile = await api.getUserProfile();
                    console.log("authSlice: Profile fetched successfully:", profile);
                    set({ user: session.user, profile, isAuthenticated: true, isAuthLoading: false });
                } catch (error) {
                    console.error("authSlice: Failed to fetch profile:", error);
                    set({ user: session.user, profile: null, isAuthenticated: true, isAuthLoading: false, authError: "Failed to fetch profile" });
                }
            } else {
                console.log("authSlice: No session found. Setting user to null.");
                set({ user: null, profile: null, isAuthenticated: false, isAuthLoading: false });
            }
        });
    },

    // We will add login/logout actions back in the next step
});
// src/store/authSlice.js
import * as api from '@/services/apiService.js';

// This slice is now "pure". It only defines state and actions.
// It doesn't "do" anything on its own.
export const createAuthSlice = (set, get) => ({
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,

    // NEW ACTION: A simple setter for when the auth state changes.
    // This will be called from our listener in main.js
    _setAuthState: (session, profile) => {
        if (session?.user) {
            set({ user: session.user, profile, isAuthenticated: true, isAuthLoading: false });
        } else {
            set({ user: null, profile: null, isAuthenticated: false, isAuthLoading: false });
        }
    },

    // The rest of the actions are fine, as they are called by user interaction.
    login: async (email, password) => {
        const { error } = await window.supabase.auth.signInWithPassword({ email, password });
        return { error };
    },
    signUp: async (email, password) => {
        const { error } = await window.supabase.auth.signUp({ email, password });
        return { error };
    },
    logout: async () => {
        await window.supabase.auth.signOut();
        return { error: null };
    },
    getUserRole: () => {
        return get().profile?.role || 'guest';
    },
});
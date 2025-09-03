// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    user: null, profile: null, isAuthLoading: true, isAuthenticated: false, authError: null,
    
    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
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

    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error };
    },
    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        return { error };
    },
    logout: async () => {
        await supabase.auth.signOut();
        return { error: null };
    },
    getUserRole: () => {
        return get().auth.profile?.role || 'guest';
    },
});
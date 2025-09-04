// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // State
    user: null, profile: null, isAuthLoading: true, isAuthenticated: false,
    authError: null, originalUser: null, originalProfile: null,

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`Auth event: ${event}`);
            
            // --- THE ROBUST FIX ---
            // We check the state *directly* from the get() function.
            // We know from our logs that this function exists.
            const isCurrentlyImpersonating = get().isImpersonating();

            if (isCurrentlyImpersonating) {
                console.log("Impersonating, ignoring auth state change event.");
                return;
            }
            // --- END FIX ---

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


    // Signs up a new user.
    signUp: async (email, password) => {
        const { error } = await supabase.auth.signUp({ email, password });
        return { error };
    },

    // Logs in an existing user.
    login: async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        return { error }; // The listener will handle the successful state change
    },

     logout: async () => {
        if (get().isImpersonating()) {
            get().stopImpersonating();
            return { error: null };
        }
        await supabase.auth.signOut();
        return { error: null };
    },

    // --- Impersonation Actions ---
    impersonateRole: (roleToImpersonate) => {
        const { user, profile, originalUser } = get().auth;
        if (profile?.role !== 'manager' || originalUser) return;
        let impersonatedUser = user;
        let impersonatedProfile = { ...profile, role: roleToImpersonate };
        if (roleToImpersonate === 'guest') {
            impersonatedUser = null;
            impersonatedProfile = null;
        }
        set(state => ({ auth: { ...state.auth, originalUser: user, originalProfile: profile, user: impersonatedUser, profile: impersonatedProfile, isAuthenticated: roleToImpersonate !== 'guest' } }));
    },
    stopImpersonating: () => {
        const { originalUser, originalProfile } = get();
        if (!originalUser) return;
        set(state => ({ auth: { ...state.auth, user: originalUser, profile: originalProfile, isAuthenticated: true, originalUser: null, originalProfile: null } }));
    },

    // --- Selectors ---
    getUserRole: () => get().auth.profile?.role || 'guest',
    isImpersonating: () => !!get().auth.originalUser,
});
// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // --- STATE ---
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,
    // --- Impersonation State ---
    originalUser: null,    // Stores the real user object during impersonation
    originalProfile: null, // Stores the real profile object (with 'manager' role)

    // --- ACTIONS ---

    // Sets up the long-running listener for auth changes.
    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`Auth event: ${event}`);
            
            // If we are currently impersonating, we ignore real-time auth changes
            // to prevent the session from overriding our fake role.
            if (get().isImpersonating()) {
                console.log("Impersonating, ignoring auth state change event.");
                return;
            }

            if (session?.user) {
                try {
                    const profile = await api.getUserProfile(session.access_token);
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

    // Logs the user out OR stops impersonating.
    logout: async () => {
        // If impersonating, the "logout" button should just revert to the real user.
        if (get().isImpersonating()) {
            get().stopImpersonating();
            return { error: null };
        }
        // Otherwise, perform a real logout.
        const { error } = await supabase.auth.signOut();
        return { error }; // Listener will handle the state change
    },

    // --- Impersonation Actions ---

    // Allows a manager to impersonate a different role.
    impersonateRole: (roleToImpersonate) => {
        const { user, profile, isImpersonating } = get();

        // Security gate: only a real manager who is not already impersonating can start.
        if (profile?.role !== 'manager' || isImpersonating()) {
            return;
        }

        let impersonatedUser = user;
        let impersonatedProfile = { ...profile, role: roleToImpersonate };

        if (roleToImpersonate === 'guest') {
            impersonatedUser = null;
            impersonatedProfile = null;
        }

        set({
            // Store the real user and profile
            originalUser: user,
            originalProfile: profile,
            // Overwrite the current user and profile with the fake ones
            user: impersonatedUser,
            profile: impersonatedProfile,
            isAuthenticated: roleToImpersonate !== 'guest',
        }, false, `auth/impersonate-${roleToImpersonate}`);
    },

    // Stops impersonation and restores the original manager session.
    stopImpersonating: () => {
        const { originalUser, originalProfile } = get();
        if (!originalUser) return; // Not impersonating, do nothing.

        set({
            // Restore the real user and profile
            user: originalUser,
            profile: originalProfile,
            isAuthenticated: true,
            // Clear the impersonation state
            originalUser: null,
            originalProfile: null,
        }, false, 'auth/stop-impersonating');
    },

    // --- SELECTORS ---

    // Gets the currently displayed role (could be the real one or an impersonated one).
    getUserRole: () => {
        return get().profile?.role || 'guest';
    },

    // Checks if impersonation is currently active.
    isImpersonating: () => {
        return !!get().originalUser;
    },
});
// src/store/authSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAuthSlice = (set, get) => ({
    // State
    user: null,
    profile: null,
    isAuthLoading: true,
    isAuthenticated: false,
    authError: null,
    originalUser: null,
    originalProfile: null,

    setUserAndProfile: (user, profile) => {
        set({
            auth: {
                ...get().auth,
                user,
                profile,
                isAuthenticated: !!user,
                isAuthLoading: false,
                authError: null
            }
        }, false, 'auth/setUserAndProfile');
    },

    
    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            if (get().auth.isImpersonating()) return;

            if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
                get().auth.setUserAndProfile(null, null);
            } else if (session?.user) {
                try {
                    const token = session.access_token;
                    const profile = await api.getUserProfile(token);
                    get().auth.setUserAndProfile(session.user, profile);

                    // --- FIX: SMARTER REDIRECT ---
                    // Only redirect if we are strictly logging in (SIGNED_IN) 
                    // OR if it's initial load but we are on the login page/root.
                    // Do NOT redirect if we are already on a dashboard or history page.
                    
                    const currentHash = window.location.hash;
                    const onSafePage = ['#owner-dashboard', '#manager-dashboard', '#order-history'].includes(currentHash);

                    if (event === 'SIGNED_IN' && !onSafePage) {
                        const role = profile?.role;
                        if (role === 'owner' || role === 'manager') {
                            console.log("[AuthSlice] Owner Login. Redirecting to Order History.");
                            window.location.hash = '#order-history';
                        }
                    }
                    // -------------------------------------

                } catch (error) {
                    console.error("[AuthSlice] Profile fetch FAILED.", error);
                    get().auth.setUserAndProfile(session.user, null);
                    set(state => ({ auth: { ...state.auth, authError: error.message } }));
                }
            } else {
                get().auth.setUserAndProfile(null, null);
            }
        });
    },

    login: async (email, password) => {
        try {
            const { session } = await api.loginViaApi(email, password);
            if (session) {
                const { error } = await supabase.auth.setSession({
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                });
                if (error) return { error };
                return { error: null };
            }
            return { error: { message: "Login failed." } };
        } catch (error) {
            return { error };
        }
    },

    signUp: async (email, password) => {
        return await api.signUpViaApi(email, password);
    },

    logout: async () => {
        if (get().auth.isImpersonating()) {
            get().auth.stopImpersonating();
            return;
        }
        await supabase.auth.signOut();
    },

    impersonateRole: (roleToImpersonate) => {
        const state = get().auth;
        
        // 1. Determine the "Real" identity
        // If already impersonating, keep the existing original. If not, save current as original.
        const originalUser = state.originalUser || state.user;
        const originalProfile = state.originalProfile || state.profile;

        // 2. Security Check: Ensure the REAL user is actually a manager
        if (originalProfile?.role !== 'manager') {
            console.warn("Attempted impersonation by non-manager.");
            return;
        }

        // 3. Construct Impersonated Profile
        let impersonatedUser = originalUser;
        let impersonatedProfile = { ...originalProfile, role: roleToImpersonate };
        
        // Special case for Guest (no user object)
        if (roleToImpersonate === 'guest') {
            impersonatedUser = null;
            impersonatedProfile = null;
        }

        // 4. Apply State
        set(s => ({
            auth: {
                ...s.auth,
                // Store the real identity if not already stored
                originalUser: originalUser, 
                originalProfile: originalProfile,
                // Set the fake identity
                user: impersonatedUser,
                profile: impersonatedProfile,
                isAuthenticated: roleToImpersonate !== 'guest'
            }
        }), false, `auth/impersonate-${roleToImpersonate}`);
    },

    stopImpersonating: () => {
        const { originalUser, originalProfile } = get().auth;
        if (!originalUser) return;
        set(state => ({
            auth: { 
                ...state.auth, 
                user: originalUser, 
                profile: originalProfile, 
                isAuthenticated: true, 
                originalUser: null, 
                originalProfile: null 
            }
        }), false, 'auth/stop-impersonating');
    },

    getUserRole: () => get().auth.profile?.role || 'guest',
    isImpersonating: () => !!get().auth.originalUser,
});
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';
import * as uiUtils from '@/utils/uiUtils.js'; // <--- FIX: Added missing import
import { useAppStore } from './appStore.js'; // Needed if you access store directly (e.g. for UI slice)

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

                    // Sync Dietary Prefs to UI Filter if they exist
                    if (profile?.dietary_preferences) {
                         // We need to access the store to set UI state. 
                         // Since 'set' here is scoped to the slice creator, we might need useAppStore.setState
                         // or just dispatch an action if available.
                         // Safe way if useAppStore is imported:
                         useAppStore.setState(state => ({
                             ui: { ...state.ui, activeAllergenFilters: profile.dietary_preferences }
                         }));
                    }

                    // --- SMARTER REDIRECT ---
                    const currentHash = window.location.hash;
                    const onSafePage = ['#owner-dashboard', '#god-dashboard', '#order-history'].includes(currentHash);

                    if (event === 'SIGNED_IN' && !onSafePage) {
                        const role = profile?.role;
                        if (role === 'owner' || role === 'god') {
                            console.log("[AuthSlice] Owner Login. Redirecting to Order History.");
                            window.location.hash = '#order-history';
                        }
                    }

                } catch (error) {
                    console.error("[AuthSlice] Profile fetch FAILED.", error);
                    // This is likely where uiUtils was being called and failing
                    uiUtils.showToast("Failed to load user profile.", "error"); 
                    
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
        const originalUser = state.originalUser || state.user;
        const originalProfile = state.originalProfile || state.profile;

        if (originalProfile?.role !== 'god') {
            console.warn("Attempted impersonation by non-god.");
            return;
        }

        let impersonatedUser = originalUser;
        let impersonatedProfile = { ...originalProfile, role: roleToImpersonate };
        
        if (roleToImpersonate === 'guest') {
            impersonatedUser = null;
            impersonatedProfile = null;
        }

        set(s => ({
            auth: {
                ...s.auth,
                originalUser: originalUser, 
                originalProfile: originalProfile,
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

    fetchProfileOnly: async () => {
        const { session } = await supabase.auth.getSession();
        if (session) {
            try {
                const profile = await api.getUserProfile(session.access_token);
                get().auth.setUserAndProfile(session.user, profile);
                
                if (profile.dietary_preferences) {
                     useAppStore.setState(state => ({
                         ui: { ...state.ui, activeAllergenFilters: profile.dietary_preferences }
                     }));
                }
            } catch (e) {
                console.error("Fetch Profile Only failed", e);
            }
        }
    },

    getUserRole: () => get().auth.profile?.role || 'guest',
    isImpersonating: () => !!get().auth.originalUser,
});
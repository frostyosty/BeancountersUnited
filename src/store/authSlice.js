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

    // --- NEW ACTION ---
    // Explicitly sets the user and profile, similar to your reference project.
    setUserAndProfile: (user, profile) => {
        set({
            auth: {
                ...get().auth,
                user,
                profile,
                isAuthenticated: !!user,
                isAuthLoading: false, // Turn off loading
                authError: null
            }
        }, false, 'auth/setUserAndProfile');
    },

    listenToAuthChanges: () => {
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log(`%c[AuthSlice] onAuthStateChange FIRED. Event: ${event}`, "color: purple;", { session });

            if (get().auth.isImpersonating()) return;

            if (event === 'SIGNED_OUT' || event === 'USER_DELETED') {
                get().auth.setUserAndProfile(null, null);
            } else if (session?.user) {
                console.log("[AuthSlice] Session found. Preparing to fetch profile...");
                try {
                    // --- THIS IS THE FIX ---
                    // We MUST use the access_token from the session object provided by the listener.
                    // Do NOT call a function that uses getSession() here.
                    const token = session.access_token;
                    console.log("[AuthSlice] Passing this access_token to getUserProfile:", token.slice(0, 20) + "...");
                    const profile = await api.getUserProfile(token);
                    // --- END OF FIX ---

                    console.log("[AuthSlice] Profile fetch SUCCESS.", { profile });
                    get().auth.setUserAndProfile(session.user, profile);
                } catch (error) {
                    console.error("[AuthSlice] Profile fetch FAILED.", error);
                    get().auth.setUserAndProfile(session.user, null);
                    set(state => ({ auth: { ...state.auth, authError: error.message } }));
                }
            } else {
                console.log("[AuthSlice] No session found. Setting user to logged-out state.");
                get().auth.setUserAndProfile(null, null);
            }
        });
    },

    // --- SIMPLIFIED AND CORRECTED LOGIN ACTION ---
    login: async (email, password) => {
        console.log("[AuthSlice] 1. login() action called.");
        try {
            console.log("[AuthSlice] 2. Calling api.loginViaApi...");
            const { session } = await api.loginViaApi(email, password);

            if (session) {
                console.log("[AuthSlice] 3. Login API successful. Calling supabase.auth.setSession().");
                // This call will trigger the onAuthStateChange listener, which will then fetch the profile.
                const { error } = await supabase.auth.setSession({
                    access_token: session.access_token,
                    refresh_token: session.refresh_token,
                });

                if (error) {
                    console.error("[AuthSlice] setSession failed:", error);
                    return { error };
                }

                console.log("[AuthSlice] 4. setSession successful. Login flow complete.");
                return { error: null }; // The listener will handle the rest.
            }

            console.warn("[AuthSlice] 3. Login API failed, no session returned.");
            return { error: { message: "Login failed." } };
        } catch (error) {
            console.error("[AuthSlice] 5. login() action FAILED.", error);
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

    // --- IMPERSONATION ACTIONS ---
    impersonateRole: (roleToImpersonate) => {
        const { user, profile, isImpersonating } = get().auth;
        // Security check: only a real manager who isn't already impersonating can start.
        const realRole = get().auth.originalProfile?.role || profile?.role;
        if (realRole !== 'manager' || isImpersonating()) return;

        let impersonatedUser = user;
        let impersonatedProfile = { ...profile, role: roleToImpersonate };
        if (roleToImpersonate === 'guest') {
            impersonatedUser = null;
            impersonatedProfile = null;
        }
        set(state => ({
            auth: { ...state.auth, originalUser: user, originalProfile: profile, user: impersonatedUser, profile: impersonatedProfile, isAuthenticated: roleToImpersonate !== 'guest' }
        }), false, `auth/impersonate-${roleToImpersonate}`);
    },
    stopImpersonating: () => {
        const { originalUser, originalProfile } = get().auth;
        if (!originalUser) return;
        set(state => ({
            auth: { ...state.auth, user: originalUser, profile: originalProfile, isAuthenticated: true, originalUser: null, originalProfile: null }
        }), false, 'auth/stop-impersonating');
    },

    // --- SELECTORS ---
    getUserRole: () => get().auth.profile?.role || 'guest',
    isImpersonating: () => !!get().auth.originalUser,
});
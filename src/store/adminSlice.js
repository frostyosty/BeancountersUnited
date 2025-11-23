import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAdminSlice = (set, get) => ({
    users: [],
    isLoadingUsers: false,
    error: null,

    // Added forceRefresh parameter
    fetchAllUsers: async (forceRefresh = false) => {
        console.log("%c[AdminSlice] fetchAllUsers() CALLED", "color: orange");
        
        const { isLoadingUsers, users } = get().admin;
        
        if (isLoadingUsers) {
            console.warn("[AdminSlice] Fetch skipped: Already loading.");
            return;
        }
        // Only skip if data exists AND we are not forcing a refresh
        if (users.length > 0 && !forceRefresh) {
            console.log("[AdminSlice] Fetch skipped: Users already in state.");
            return;
        }

        console.log("[AdminSlice] setting isLoadingUsers = true...");
        set(state => ({ admin: { ...state.admin, isLoadingUsers: true } }));

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            console.log("[AdminSlice] API Request: fetching users...");
            const userList = await api.listAllUsers(session.access_token);
            console.log(`[AdminSlice] API Success: Got ${userList.length} users.`);

            set(state => ({ admin: { ...state.admin, users: userList, isLoadingUsers: false } }));
            
            // Ensure uiSlice exists before calling this
            if (get().ui && get().ui.triggerPageRender) {
                get().ui.triggerPageRender(); 
            }

        } catch (error) {
            console.error("[AdminSlice] Fetch FAILED:", error);
            set(state => ({ admin: { ...state.admin, error: error.message, isLoadingUsers: false } }));
        }
    },
    
    // ... updateUserRole remains the same ...
    updateUserRole: async (userId, newRole, isVerifiedBuyer, canSeeOrderHistory) => {
        const originalUsers = get().admin.users;
        const updatedUsers = originalUsers.map(u =>
            u.id === userId ? { ...u, role: newRole, is_verified_buyer: isVerifiedBuyer, can_see_order_history: canSeeOrderHistory } : u
        );
        set(state => ({ admin: { ...state.admin, users: updatedUsers } }));

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");
            await api.updateUser(userId, newRole, isVerifiedBuyer, canSeeOrderHistory, session.access_token);
        } catch (error) {
            console.error("Failed to update user:", error);
            set(state => ({ admin: { ...state.admin, users: originalUsers } }));
            alert(`Failed to update user: ${error.message}`);
        }
    },
});
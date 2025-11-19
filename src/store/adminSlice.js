// src/store/adminSlice.js
import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAdminSlice = (set, get) => ({
    // --- STATE ---
    users: [],
    isLoadingUsers: false,
    error: null,

    // --- ACTIONS ---
    fetchAllUsers: async () => {
        const { isLoadingUsers, users } = get().admin;
        if (isLoadingUsers || users.length > 0) return;

        set(state => ({ admin: { ...state.admin, isLoadingUsers: true } }));
        try {
            // Fix 1: Use the imported supabase client, not window.supabase
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            const userList = await api.listAllUsers(session.access_token);
            
            set(state => ({ admin: { ...state.admin, users: userList, isLoadingUsers: false } }), false, 'admin/fetchUsersSuccess');
            
            // Fix 2: Use 'get()' to access the UI slice safely
            get().ui.triggerPageRender(); 

        } catch (error) {
            console.error("[AdminSlice] Fetch FAILED.", error);
            set(state => ({ admin: { ...state.admin, error: error.message, isLoadingUsers: false } }), false, 'admin/fetchUsersError');
        }
    },

    updateUserRole: async (userId, newRole, isVerifiedBuyer, canSeeOrderHistory) => {
        const originalUsers = get().admin.users;
        const updatedUsers = originalUsers.map(u =>
            u.id === userId ? { ...u, role: newRole, is_verified_buyer: isVerifiedBuyer, can_see_order_history: canSeeOrderHistory } : u
        );
        set(state => ({ admin: { ...state.admin, users: updatedUsers } }));

        try {
            // Fix 1: Use the imported supabase client
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
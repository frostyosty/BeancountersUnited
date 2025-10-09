// src/store/adminSlice.js
import * as api from '@/services/apiService.js';

export const createAdminSlice = (set, get) => ({
    // --- STATE ---
    users: [],
    isLoadingUsers: false,
    error: null,

    // --- ACTIONS ---a
    fetchAllUsers: async () => {
        console.log("[AdminSlice] 1. fetchAllUsers() CALLED."); // <-- ADD THIS
        const { isLoadingUsers, users } = get().admin;
        if (isLoadingUsers || users.length > 0) {
            console.log("[AdminSlice] 2. Skipping fetch."); // <-- ADD THIS
            return;
        }
        set(state => ({ admin: { ...state.admin, isLoadingUsers: true } }));
        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");
            const userList = await api.listAllUsers(session.access_token);
            console.log(`[AdminSlice] 3. Fetch successful. Received ${userList.length} users.`); // <-- ADD THIS
            set(state => ({ admin: { ...state.admin, users: userList, isLoadingUsers: false } }), false, 'admin/fetchUsersSuccess');
            // --- ADD THESE LOGS ---
            console.log("[AdminSlice] Fetch complete. Attempting to trigger page re-render...");
            const uiSlice = useAppStore.getState().ui;
            console.log("[AdminSlice] Found uiSlice:", uiSlice);
            console.log("[AdminSlice] Does triggerPageRender exist?", typeof uiSlice?.triggerPageRender);
            
            uiSlice.triggerPageRender();
            console.log("[AdminSlice] triggerPageRender() was called.");
        } catch (error) {
            console.error("[AdminSlice] 4. Fetch FAILED.", error); // <-- ADD THIS
            set(state => ({ admin: { ...state.admin, error: error.message, isLoadingUsers: false } }), false, 'admin/fetchUsersError');
        }
    },


    updateUserRole: async (userId, newRole, isVerifiedBuyer, canSeeOrderHistory) => {
        const originalUsers = get().admin.users;
        // Optimistically update the local state with the new value
        const updatedUsers = originalUsers.map(u =>
            u.id === userId ? { ...u, role: newRole, is_verified_buyer: isVerifiedBuyer, can_see_order_history: canSeeOrderHistory } : u
        );
        set(state => ({ admin: { ...state.admin, users: updatedUsers } }));

        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            // Pass the new value to the API service
            await api.updateUser(userId, newRole, isVerifiedBuyer, canSeeOrderHistory, session.access_token);
        } catch (error) {
            console.error("Failed to update user:", error);
            // Revert on failure
            set(state => ({ admin: { ...state.admin, users: originalUsers } }));
            alert(`Failed to update user: ${error.message}`);
        }
    },
});
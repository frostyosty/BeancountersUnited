// src/store/adminSlice.js
import * as api from '@/services/apiService.js';

export const createAdminSlice = (set, get) => ({
    // --- STATE ---
    users: [],
    isLoadingUsers: false,
    error: null,

    // --- ACTIONS ---
    fetchAllUsers: async () => {
        const { isLoadingUsers, users } = get().admin;

        // Safety Check: If already loading or data exists, do nothing.
        if (isLoadingUsers || users.length > 0) {
            return; // Return immediately, DO NOT set state again.
        }
        // --- THIS IS THE CRITICAL FIX ---
        // We now set the loading state BEFORE the async part,
        // but only if we are actually going to fetch.
        set(state => ({ admin: { ...state.admin, isLoadingUsers: true } }));

        console.log("Fetching all users from API...");
        try {
             const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");
            
            const userList = await api.listAllUsers(session.access_token);
            set(state => ({ admin: { ...state.admin, users: userList, isLoadingUsers: false } }), false, 'admin/fetchUsersSuccess');
        } catch (error) {
            console.error("Failed to fetch all users:", error);
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
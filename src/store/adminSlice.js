// src/store/adminSlice.js
import * as api from '@/services/apiService.js';

export const createAdminSlice = (set, get) => ({
    // --- STATE ---
    users: [],
    isLoadingUsers: true,
    error: null,

    // --- ACTIONS ---
 fetchAllUsers: async () => {
        // --- THIS IS THE FIX ---
        // 1. Get the current state of the admin slice.
        const { isLoadingUsers, users } = get().admin;

        // 2. Safety Check: If we are already loading, or if the user list is already populated, do nothing.
        if (isLoadingUsers || users.length > 0) {
            console.log("Skipping fetchAllUsers: already loading or data already exists.");
            return;
        }
        // --- END OF FIX ---

        console.log("Fetching all users from API...");
        set(state => ({ admin: { ...state.admin, isLoadingUsers: true } }));
        try {
            // No need to get the token here, the apiService should handle it.
            const userList = await api.listAllUsers(); // Simplified call
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
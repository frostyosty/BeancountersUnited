// src/store/adminSlice.js
import * as api from '@/services/apiService.js';

export const createAdminSlice = (set, get) => ({
    // --- STATE ---
    users: [],
    isLoadingUsers: true,
    error: null,

    // --- ACTIONS ---
    fetchAllUsers: async () => {
        set(state => ({ admin: { ...state.admin, isLoadingUsers: true } }));
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

    updateUserRole: async (userId, newRole, isVerifiedBuyer) => {
        // Optimistic update
        const originalUsers = get().admin.users;
        const updatedUsers = originalUsers.map(u => u.id === userId ? { ...u, role: newRole, is_verified_buyer: isVerifiedBuyer } : u);
        set(state => ({ admin: { ...state.admin, users: updatedUsers } }));

        try {
            const { data: { session } } = await window.supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            await api.updateUser(userId, newRole, isVerifiedBuyer, session.access_token);
        } catch (error) {
            console.error("Failed to update user:", error);
            // Revert on failure
            set(state => ({ admin: { ...state.admin, users: originalUsers } }));
            alert(`Failed to update user: ${error.message}`);
        }
    },
});
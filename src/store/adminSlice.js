import { supabase } from '@/supabaseClient.js';
import * as api from '@/services/apiService.js';

export const createAdminSlice = (set, get) => ({
    users: [], // Keep specific auth users here
    clients: [], // NEW: Rich client data with spend stats
    isLoadingClients: false,
    isLoadingUsers: false,
    error: null,

    // Added forceRefresh parameter
    fetchAllUsers: async (forceRefresh = false) => {
        console.log("%c[AdminSlice] fetchAllUsers() CALLED", "color: orange");
        
        const { isLoadingUsers, users } = get().admin;
        
        if (isLoadingUsers) return;
        if (users.length > 0 && !forceRefresh) return;

        set(state => ({ admin: { ...state.admin, isLoadingUsers: true } }));

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");

            const userList = await api.listAllUsers(session.access_token);
            
            // --- FIX: Handle null/undefined response ---
            const safeUserList = Array.isArray(userList) ? userList : [];
            
            console.log(`[AdminSlice] API Success: Got ${safeUserList.length} users.`);

            set(state => ({ admin: { ...state.admin, users: safeUserList, isLoadingUsers: false } }));
            
            // Only trigger render if UI slice exists
            if (get().ui?.triggerPageRender) get().ui.triggerPageRender(); 

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
        
        // 1. Optimistic Update
        set(state => ({ admin: { ...state.admin, users: updatedUsers } }));
        
        // FIX: Tell the UI to repaint immediately
        get().ui.triggerPageRender();

        try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) throw new Error("Not authenticated");
            await api.updateUser(userId, newRole, isVerifiedBuyer, canSeeOrderHistory, session.access_token);
        } catch (error) {
            console.error("Failed to update user:", error);
            // Revert
            set(state => ({ admin: { ...state.admin, users: originalUsers } }));
            get().ui.triggerPageRender();
            alert(`Failed to update user: ${error.message}`);
        }
    },
     fetchClients: async () => {
        set(state => ({ admin: { ...state.admin, isLoadingClients: true } }));
        try {
            const { data: { session } } = await supabase.auth.getSession();
            const data = await api.getClients(session.access_token);
            set(state => ({ admin: { ...state.admin, clients: data, isLoadingClients: false } }));
        } catch (e) {
            console.error("Fetch Clients Failed", e);
            set(state => ({ admin: { ...state.admin, isLoadingClients: false } }));
        }
    }
});
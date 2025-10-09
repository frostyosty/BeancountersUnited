//api/user/manage.js

import { supabaseAdmin, getUserFromRequest } from '../_db.js';

export default async function handler(req, res) {
    const { profile } = await getUserFromRequest(req);
    if (profile?.role !== 'manager') {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to manage users.' });
    }
    
    if (req.method === 'GET') {
        try {
            // 1. Fetch all profiles. (This part is fine)
            const { data: profiles, error: profilesError } = await supabaseAdmin
                .from('profiles')
                .select(`id, email, role, full_name, is_verified_buyer, can_see_order_history`);
            if (profilesError) throw profilesError;

            // --- THIS IS THE FINAL FIX ---
            // 2. Call our new database function using rpc().
            const { data: authUsers, error: authUsersError } = await supabaseAdmin
                .rpc('get_all_user_metadata');
            if (authUsersError) throw authUsersError;
            // --- END OF FIX ---

            // 3. Create a lookup map (same as before).
            const authUserMap = new Map();
            for (const authUser of authUsers) {
                authUserMap.set(authUser.id, {
                    created_at: authUser.created_at,
                    last_sign_in_at: authUser.last_sign_in_at
                });
            }

            // 4. Merge the data (same as before).
            const formattedData = profiles.map(profile => ({
                ...profile,
                ...(authUserMap.get(profile.id) || {})
            }));

            return res.status(200).json(formattedData);
        } catch (error) {
            console.error("CRITICAL ERROR in GET /api/user/manage:", error);
            return res.status(500).json({ error: error.message });
        }
    }

    if (req.method === 'PUT') {
        try {
            // Add the new field to the update logic
            const { userId, newRole, isVerifiedBuyer, canSeeOrderHistory } = req.body;
            const validRoles = ['customer', 'owner', 'manager'];

            if (!userId || !validRoles.includes(newRole)) {
                return res.status(400).json({ error: 'Invalid userId or newRole provided.' });
            }

            // You cannot demote yourself if you are the last manager
            if (profile.id === userId && newRole !== 'manager') {
                const { count, error: countError } = await supabaseAdmin.from('profiles').select('*', { count: 'exact' }).eq('role', 'manager');
                if (countError) throw countError;
                if (count <= 1) {
                    return res.status(400).json({ error: 'Cannot demote the last manager.' });
                }
            }

            const { data, error } = await supabaseAdmin
                .from('profiles')
                .update({
                    role: newRole,
                    is_verified_buyer: isVerifiedBuyer,
                    can_see_order_history: canSeeOrderHistory // Add the new field to the update
                })
                .eq('id', userId)
                .select()
                .single();

            if (error) throw error;

            return res.status(200).json(data);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(405).end('Method Not Allowed');
}
import { supabaseAdmin, getUserFromRequest } from '../_db.js';

export default async function handler(req, res) {
    const { profile } = await getUserFromRequest(req);
    if (profile?.role !== 'manager') {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to manage users.' });
    }

    if (req.method === 'GET') {
        try {
            // Include the new 'can_see_order_history' column in the select
            const { data, error } = await supabaseAdmin
                .from('profiles')
                .select(`id, email, role, full_name, is_verified_buyer, can_see_order_history, users(created_at, last_sign_in_at)`);
            
            if (error) throw error;
            
            // Flatten the data
            const formattedData = data.map(p => ({
                id: p.id, email: p.email, role: p.role, full_name: p.full_name,
                is_verified_buyer: p.is_verified_buyer,
                can_see_order_history: p.can_see_order_history, // Add the new field
                created_at: p.users.created_at, last_sign_in_at: p.users.last_sign_in_at
            }));
            
            return res.status(200).json(formattedData);
        } catch (error) {
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
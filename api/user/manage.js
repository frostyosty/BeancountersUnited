// /api/users/manage.js
import { supabaseAdmin, getUserFromRequest } from '../_db.js';
export default async function handler(req, res) {
    // --- Security Check: This entire endpoint is for Managers only ---
    const { profile } = await getUserFromRequest(req);
    if (profile?.role !== 'manager') {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to manage users.' });
    }

    if (req.method === 'GET') {
        try {
            const { data, error } = await supabaseAdmin
                .from('users') // Assumes a view on auth.users
                .select(`id, email, created_at, last_sign_in_at, profiles ( role, full_name, is_verified_buyer )`);
            if (error) throw error;
            
            const formattedData = data.map(u => ({
                ...u,
                ...(Array.isArray(u.profiles) && u.profiles.length > 0 ? u.profiles[0] : { role: 'customer', full_name: '', is_verified_buyer: false })
            }));
            return res.status(200).json(formattedData);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }


    if (req.method === 'PUT') {
        // --- Update a user's role ---
        try {
            const { userId, newRole, isVerifiedBuyer } = req.body;
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
                .update({ role: newRole, is_verified_buyer: isVerifiedBuyer })
                .eq('id', userId)
                .select()
                .single();
            
            if (error) throw error;
            
            return res.status(200).json(data);
        } catch (error) {
            console.error("Error updating user role:", error);
            return res.status(500).json({ error: error.message });
        }
    }

    res.setHeader('Allow', ['GET', 'PUT']);
    return res.status(405).end('Method Not Allowed');
}
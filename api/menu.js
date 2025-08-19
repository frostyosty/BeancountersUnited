// api/menu.js
import { supabaseAdmin, getUserFromRequest } from './_db.js';

export default async function handler(req, res) {
    if (req.method === 'GET') {
        // GET is public, no auth needed.
        try {
            const { data, error } = await supabaseAdmin.from('menu_items').select('*').order('name');
            if (error) throw error;
            return res.status(200).json(data);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    // For POST, PUT, DELETE, we require authentication and a specific role.
    const { user, profile, error: authError } = await getUserFromRequest(req);

    if (authError || !user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const userRole = profile?.role;
    if (userRole !== 'owner' && userRole !== 'manager') {
        return res.status(403).json({ error: 'Forbidden: Insufficient privileges.' });
    }

    // --- Protected Routes ---
    if (req.method === 'POST') {
        // Add a new menu item
        try {
            const { name, description, price, category, image_url } = req.body;
            // Basic validation
            if (!name || !price) {
                return res.status(400).json({ error: 'Name and price are required.' });
            }
            const { data, error } = await supabaseAdmin
                .from('menu_items')
                .insert([{ name, description, price: Number(price), category, image_url }])
                .select()
                .single();
            if (error) throw error;
            return res.status(201).json(data);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    if (req.method === 'PUT') {
        // Update an existing menu item
        try {
            const { id } = req.query;
            const { name, description, price, category, image_url } = req.body;
            if (!id) return res.status(400).json({ error: 'Item ID is required.' });

            const { data, error } = await supabaseAdmin
                .from('menu_items')
                .update({ name, description, price: Number(price), category, image_url })
                .eq('id', id)
                .select()
                .single();
            if (error) throw error;
            return res.status(200).json(data);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    if (req.method === 'DELETE') {
        // Delete a menu item
        try {
            const { id } = req.query;
            if (!id) return res.status(400).json({ error: 'Item ID is required.' });

            const { error } = await supabaseAdmin.from('menu_items').delete().eq('id', id);
            if (error) throw error;
            return res.status(204).send(); // No Content
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    // If method is not handled
    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
}
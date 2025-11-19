import { supabaseAdmin, getUserFromRequest } from './_db.js';

export default async function handler(req, res) {
    console.log(`[API /menu] Method: ${req.method}`);

    // --- GET: List Items ---
    if (req.method === 'GET') {
        const { data, error } = await supabaseAdmin.from('menu_items').select('*').order('name');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
    }

    // --- POST: Create Item ---
    if (req.method === 'POST') {
        const { user, error: authError } = await getUserFromRequest(req);
        if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

        const { error } = await supabaseAdmin.from('menu_items').insert([req.body]);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(201).json({ success: true });
    }

    // --- PUT: Update Item ---
    if (req.method === 'PUT') {
        const { id } = req.query; // ?id=123
        if (!id) return res.status(400).json({ error: "Missing Item ID" });

        const { user, error: authError } = await getUserFromRequest(req);
        if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

        // Exclude id from body to prevent changing it
        const { id: _, ...updates } = req.body;

        const { error } = await supabaseAdmin.from('menu_items').update(updates).eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ success: true });
    }

    // --- DELETE: Remove Item ---
    if (req.method === 'DELETE') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: "Missing Item ID" });

        const { user, error: authError } = await getUserFromRequest(req);
        if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

        const { error } = await supabaseAdmin.from('menu_items').delete().eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
}
import { createClient } from '@supabase/supabase-js';

// --- CONFIG: New Table Names ---
const TABLES = {
    MENU: 'mealmates_menu_items',
    PROFILES: 'mealmates_profiles'
};

export default async function handler(req, res) {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    
    if (!supabaseUrl || !supabaseServiceKey) {
        return res.status(500).json({ error: "Server Config Error" });
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // --- GET (Public Access) ---
    if (req.method === 'GET') {
        const { data, error } = await supabaseAdmin
            .from(TABLES.MENU) // <--- FIX: Using new table name
            .select('*')
            .order('name');
        
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
    }

    // --- AUTH CHECK (Required for Write Operations) ---
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Missing Token" });

    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

    // Verify Admin Role
    const { data: profile } = await supabaseAdmin
        .from(TABLES.PROFILES)
        .select('role')
        .eq('id', user.id)
        .single();

    if (!profile || (profile.role !== 'god' && profile.role !== 'owner' && profile.role !== 'manager')) {
        return res.status(403).json({ error: "Forbidden" });
    }

    // --- POST (Add Item) ---
    if (req.method === 'POST') {
        const { error } = await supabaseAdmin
            .from(TABLES.MENU)
            .insert([req.body]);
        
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ success: true });
    }

    // --- PUT (Update Item) ---
    if (req.method === 'PUT') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: "Missing ID" });

        const { error } = await supabaseAdmin
            .from(TABLES.MENU)
            .update(req.body)
            .eq('id', id);
        
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ success: true });
    }

    // --- DELETE (Remove Item) ---
    if (req.method === 'DELETE') {
        const { id } = req.query;
        if (!id) return res.status(400).json({ error: "Missing ID" });

        const { error } = await supabaseAdmin
            .from(TABLES.MENU)
            .delete()
            .eq('id', id);
        
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
}
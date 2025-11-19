import { supabaseAdmin, getUserFromRequest } from './_db.js';

export default async function handler(req, res) {
    // Handle CORS preflight if necessary, though Vercel usually handles it.
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method === 'GET') {
        const { data, error } = await supabaseAdmin.from('menu_items').select('*').order('name');
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json(data);
    }

    // --- POST (Create) ---
    if (req.method === 'POST') {
        try {
            const { user, error: authError } = await getUserFromRequest(req);
            if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

            // CLEAN THE DATA: Ensure we don't send the raw file object or extra fields
            const { name, description, price, category, image_url } = req.body;

            console.log("[API /menu] Inserting new item:", { name, price, category });

            const { data, error } = await supabaseAdmin
                .from('menu_items')
                .insert([{ 
                    name, 
                    description, 
                    price: parseFloat(price), 
                    category, 
                    image_url 
                }])
                .select();

            if (error) {
                console.error("[API /menu] Insert Error:", error);
                throw error;
            }
            return res.status(201).json({ success: true, data });

        } catch (e) {
            console.error("[API /menu] CRITICAL POST ERROR:", e);
            return res.status(500).json({ error: e.message || "Database Error" });
        }
    }

    // --- DELETE ---
    if (req.method === 'DELETE') {
        const { id } = req.query;
        const { user, error: authError } = await getUserFromRequest(req);
        if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

        const { error } = await supabaseAdmin.from('menu_items').delete().eq('id', id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ success: true });
    }

    // --- PUT (Update) ---
    if (req.method === 'PUT') {
         const { id } = req.query;
         const { user, error: authError } = await getUserFromRequest(req);
         if (authError || !user) return res.status(401).json({ error: "Unauthorized" });

         const { id: _, ...updates } = req.body; // Remove ID from body
         
         // Clean numerical values
         if (updates.price) updates.price = parseFloat(updates.price);

         const { error } = await supabaseAdmin.from('menu_items').update(updates).eq('id', id);
         if (error) return res.status(500).json({ error: error.message });
         return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
    res.status(405).json({ error: `Method ${req.method} Not Allowed` });
}
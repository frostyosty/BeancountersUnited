import { supabaseAdmin } from './_db.js';

export default async function handler(req, res) {
    console.log(`[API /settings] Method: ${req.method}`);

    // --- GET: Fetch Settings ---
    if (req.method === 'GET') {
        try {
            const { data, error } = await supabaseAdmin
                .from('site_settings')
                .select('key, value');

            if (error && error.code !== 'PGRST116' && error.code !== '42P01') throw error;

            // Convert DB rows [{key: 'a', value: 'b'}] into Object {a: b}
            const settingsObject = (data || []).reduce((acc, row) => {
                try {
                    // Parse JSON strings back to objects for specific keys
                    if (['themeVariables', 'ownerPermissions', 'menuCategories'].includes(row.key)) {
                        acc[row.key] = JSON.parse(row.value);
                    } else {
                        acc[row.key] = row.value;
                    }
                } catch (e) {
                    acc[row.key] = row.value;
                }
                return acc;
            }, {});

            return res.status(200).json(settingsObject);
        } catch (e) {
            console.error("GET Error:", e);
            return res.status(500).json({ error: "Failed to fetch settings." });
        }
    }

    // --- PUT: Update Settings ---
    if (req.method === 'PUT') {
        try {
            const updates = req.body; // e.g. { websiteName: "New Name", themeVariables: {...} }
            console.log("[API /settings] Received updates:", Object.keys(updates));

            // We need to upsert each key-value pair individually into the 'site_settings' table
            const upsertPromises = Object.entries(updates).map(([key, value]) => {
                // Stringify objects before saving
                const dbValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                
                return supabaseAdmin
                    .from('site_settings')
                    .upsert({ key, value: dbValue }, { onConflict: 'key' });
            });

            await Promise.all(upsertPromises);

            return res.status(200).json({ success: true });

        } catch (e) {
            console.error("PUT Error:", e);
            return res.status(500).json({ error: e.message });
        }
    }

    res.setHeader('Allow', ['GET', 'PUT']);
    res.status(405).json({ error: `Method ${req.method} Not Allowed` });
}
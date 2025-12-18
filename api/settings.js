// api/settings.js
import { createClient } from '@supabase/supabase-js';
import { TABLES } from '../src/config/tenancy.js';

export default async function handler(req, res) {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
        return res.status(500).json({ error: "Server Config Error" });
    }
    
     const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    if (req.method === 'GET') {
        try {
const { data, error } = await supabaseAdmin.from(TABLES.SETTINGS).select('key, value');

            if (error) throw error;

            const settingsObject = (data || []).reduce((acc, row) => {
                try {
                    // FIX: Added 'headerLogoConfig' to the whitelist
                    const jsonKeys = [
                        'themeVariables', 
                        'ownerPermissions', 
                        'menuCategories', 
                        'headerSettings', 
                        'paymentConfig', 
                        'uiConfig', 
                        'aboutUs',
                        'headerLogoConfig',
                        'archiveSettings'
                    ];

                    if (jsonKeys.includes(row.key)) {
                        acc[row.key] = JSON.parse(row.value);
                    } else {
                        // Handle booleans
                        if (row.value === 'true') acc[row.key] = true;
                        else if (row.value === 'false') acc[row.key] = false;
                        else acc[row.key] = row.value;
                    }
                } catch (e) {
                    acc[row.key] = row.value;
                }
                return acc;
            }, {});

            return res.status(200).json(settingsObject);
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // --- PUT: Update Settings ---
    if (req.method === 'PUT') {
        try {
            const updates = req.body;
            
            // Create array of promises
            const upsertPromises = Object.entries(updates).map(([key, value]) => {
                const dbValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
                // Return the promise so we can check results
                return supabaseAdmin
                    .from('site_settings')
                    .upsert({ key, value: dbValue }, { onConflict: 'key' });
            });

            // Wait for all
            const results = await Promise.all(upsertPromises);

            // --- FIX: CHECK FOR ERRORS ---
            // Supabase upsert returns { error: ... }. We must check it.
            const errors = results.filter(r => r.error).map(r => r.error.message);
            
            if (errors.length > 0) {
                console.error("Settings Database Error:", errors);
                // Throwing error here stops the 200 OK response
                throw new Error("Database write failed: " + errors[0]);
            }

            return res.status(200).json({ success: true });

        } catch (e) {
            console.error("PUT Settings Error:", e);
            return res.status(500).json({ error: e.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
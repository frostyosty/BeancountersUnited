// /api/settings.js
import { supabaseAdmin } from './_db.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("[API /settings] Fetching from 'site_settings' table...");
        const { data, error, status } = await supabaseAdmin
            .from('site_settings')
            .select('key, value');

        console.log(`[API /settings] Supabase query returned status: ${status}`);
        console.log(`[API /settings] Error object from query:`, error);
        console.log(`[API /settings] Data array from query (length: ${data?.length || 0}):`, data);

        if (error) {
            // Let's explicitly check for the "table doesn't exist" error
            if (error.code === '42P01') {
                console.warn("[API /settings] The 'site_settings' table does not exist.");
                return res.status(200).json({}); // Return empty object if table is missing
            }
            throw error; // Throw other database errors
        }

        if (!data || data.length === 0) {
            console.warn("[API /settings] The 'site_settings' table is empty.");
            return res.status(200).json({});
        }

        const settingsObject = data.reduce((acc, row) => {
            try {
                if (['themeVariables', 'ownerPermissions'].includes(row.key)) {
                    acc[row.key] = JSON.parse(row.value);
                } else {
                    acc[row.key] = row.value;
                }
            } catch (e) {
                acc[row.key] = row.value;
            }
            return acc;
        }, {});
        
        console.log("[API /settings] Successfully processed settings. Sending object:", settingsObject);
        return res.status(200).json(settingsObject);

    } catch (e) {
        console.error("CRITICAL ERROR in /api/settings:", e);
        return res.status(500).json({ error: "Failed to fetch site settings." });
    }
}
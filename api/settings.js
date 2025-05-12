// api/settings.js
import { getActiveDbClient, getUserFromRequest, getUserProfile } from './_db.js';

// For storing settings, you have a few options:
// 1. A dedicated 'settings' table in your primary DB (Supabase/Turso).
// 2. Vercel Edge Config (good for globally distributed, low-latency reads).
// 3. A simple JSON file if settings rarely change and a rebuild is acceptable (not for manager UI).
// We'll assume a 'site_settings' table in the primary DB for this example.
// It might have rows like: { key: 'websiteName', value: 'My Restaurant' }, { key: 'themeVariables', value: '{...}' }

export default async function handler(req, res) {
    const { client, type } = await getActiveDbClient(); // Get DB to store/retrieve settings
    const user = await getUserFromRequest(req);
    let userProfile = null;
    if (user) userProfile = await getUserProfile(user.id);

    if (req.method === 'GET') {
        // Fetch all settings (or specific ones)
        try {
            let settings = {
                websiteName: "My Awesome Restaurant", // Default
                // activeThemeCss: "css/theme-default.css", // Default
                themeVariables: {}, // Default (empty, uses CSS defaults)
                currentDbProvider: process.env.ACTIVE_DB_PROVIDER || 'supabase' // Read from env
            };

            if (type === 'supabase') {
                const { data, error } = await client.from('site_settings').select('key, value');
                if (error) throw error;
                data.forEach(setting => {
                    try {
                        // Assuming 'value' for themeVariables is stored as a JSON string
                        settings[setting.key] = (setting.key === 'themeVariables' || setting.key === 'tursoCredentials') ? JSON.parse(setting.value) : setting.value;
                    } catch (e) {
                        settings[setting.key] = setting.value; // parsing error, use raw
                    }
                });
            } else if (type === 'turso') {
                const rs = await client.execute("SELECT key, value FROM site_settings;");
                rs.rows.forEach(row => {
                     try {
                        settings[row.key] = (row.key === 'themeVariables' || row.key === 'tursoCredentials') ? JSON.parse(row.value) : row.value;
                    } catch (e) {
                        settings[row.key] = row.value;
                    }
                });
            }
             // Override/set based on current actual runtime environment for DB provider
            settings.currentDbProvider = process.env.ACTIVE_DB_PROVIDER || 'supabase';

            return res.status(200).json(settings);
        } catch (error) {
            console.error("Error fetching site settings:", error);
            // Return defaults on error so client doesn't break
             const defaults = {
                websiteName: "My Awesome Restaurant",
                themeVariables: {},
                currentDbProvider: process.env.ACTIVE_DB_PROVIDER || 'supabase'
            };
            return res.status(200).json(defaults); // Send defaults with 200
        }
    } else if (req.method === 'PUT') {
        // Update settings (Manager only)
        if (!userProfile || userProfile.role !== 'manager') {
            return res.status(403).json({ message: 'Forbidden: Insufficient privileges.' });
        }
        try {
            const { websiteName, themeVariables, targetDbProvider /*, tursoCredentials */ } = req.body;
            const updates = [];

            if (websiteName !== undefined) {
                updates.push({ key: 'websiteName', value: websiteName });
            }
            if (themeVariables !== undefined) { // themeVariables is an object
                updates.push({ key: 'themeVariables', value: JSON.stringify(themeVariables) });
            }
            // if (tursoCredentials !== undefined) { // For securely storing Turso creds if not using env vars
            //     updates.push({ key: 'tursoCredentials', value: JSON.stringify(tursoCredentials) });
            // }


            // Handle DB provider switch. THIS IS COMPLEX.
            // This API endpoint would aim to update an ENV VAR in Vercel that `_db.js` reads.
            // Vercel API can be used to update Env Vars, but requires a Vercel Access Token.
            // This is typically done OUTSIDE the app, e.g. via Vercel CLI or Dashboard.
            // A simpler approach here might be setting a flag in the DB,
            // but _db.js reads from process.env.ACTIVE_DB_PROVIDER, so that ENV VAR needs to change.
            // For now, let's just acknowledge the intent and "store" the target.
            // A *manual redeploy* via Vercel dashboard after changing ACTIVE_DB_PROVIDER env var would be simplest.
            if (targetDbProvider) {
                 console.warn(`Manager requested DB switch to: ${targetDbProvider}. Manual Vercel ENV update and redeploy needed for 'ACTIVE_DB_PROVIDER=${targetDbProvider}'.`);
                 // You could store this preference in the DB:
                 updates.push({ key: 'targetDbProvider', value: targetDbProvider });
                 // However, your _db.js reads process.env.ACTIVE_DB_PROVIDER, so the Vercel Env Var is king.
            }


            if (updates.length === 0) {
                return res.status(400).json({ message: 'No settings provided to update.' });
            }

            // Perform upserts (update or insert)
            for (const setting of updates) {
                if (type === 'supabase') {
                    const { error } = await client.from('site_settings')
                        .upsert(setting, { onConflict: 'key' }); // Assumes 'key' is unique constraint
                    if (error) throw error;
                } else if (type === 'turso') {
                    await client.execute({
                        sql: "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                        args: [setting.key, setting.value]
                    });
                }
            }
            return res.status(200).json({ message: 'Settings updated successfully.' });

        } catch (error) {
            console.error('Error updating site settings:', error);
            return res.status(500).json({ message: 'Failed to update settings', error: error.message });
        }
    } else {
        res.setHeader('Allow', ['GET', 'PUT']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}
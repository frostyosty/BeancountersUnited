// api/settings.js
import { createClient } from '@supabase/supabase-js';

// FIX: Define correct table names
const TABLES = {
    SETTINGS: 'beancountersunited_site_settings',
    AUDIT: 'beancountersunited_audit_logs'
};

export default async function handler(req, res) {
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
        return res.status(500).json({ error: "Server Config Error" });
    }
    
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // --- GET: Fetch Settings ---
    if (req.method === 'GET') {
        try {
            // FIX: Use TABLES.SETTINGS
            const { data, error } = await supabaseAdmin
                .from(TABLES.SETTINGS)
                .select('key, value');

            if (error) throw error;

            const settingsObject = (data || []).reduce((acc, row) => {
                try {
                    // JSON Whitelist
                    const jsonKeys = [
                        'themeVariables', 'ownerPermissions', 'menuCategories', 
                        'headerSettings', 'paymentConfig', 'uiConfig', 'aboutUs', 
                        'headerLogoConfig', 'archiveSettings', 'dashboardConfig'
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
            console.error("GET Settings Error:", e);
            return res.status(500).json({ error: e.message });
        }
    }

    // --- PUT: Update Settings ---
    if (req.method === 'PUT') {
        try {
            // 1. Auth Check (for Audit Log)
            const token = req.headers.authorization?.split(' ')[1];
            let actorId = null;
            if (token) {
                const { data: { user } } = await supabaseAdmin.auth.getUser(token);
                actorId = user?.id;
            }

            const updates = req.body;
            const keysToUpdate = Object.keys(updates);

            // 2. Fetch OLD values (for Audit)
            // FIX: Use TABLES.SETTINGS
            const { data: currentData } = await supabaseAdmin
                .from(TABLES.SETTINGS)
                .select('key, value')
                .in('key', keysToUpdate);

            // 3. Prepare Audit Logs
            const auditEntries = [];
            
            keysToUpdate.forEach(key => {
                const currentValObj = currentData ? currentData.find(r => r.key === key) : null;
                const oldValStr = currentValObj ? currentValObj.value : null;
                const newValStr = typeof updates[key] === 'object' ? JSON.stringify(updates[key]) : String(updates[key]);

                if (oldValStr !== newValStr) {
                    let desc = `Updated ${key}`;
                    if (key === 'themeVariables') desc = "Visual Theme";
                    if (key === 'headerLogoConfig') desc = "Header Logo";
                    
                    auditEntries.push({
                        actor_id: actorId,
                        action_type: `SETTINGS: ${desc}`,
                        old_value: oldValStr,
                        new_value: newValStr
                    });
                }
            });

            // 4. Save Audit Logs
            if (auditEntries.length > 0) {
                // FIX: Use TABLES.AUDIT
                await supabaseAdmin.from(TABLES.AUDIT).insert(auditEntries);
            }

            // 5. Perform Updates
            const upsertPromises = keysToUpdate.map(key => {
                const dbValue = typeof updates[key] === 'object' ? JSON.stringify(updates[key]) : String(updates[key]);
                // FIX: Use TABLES.SETTINGS
                return supabaseAdmin
                    .from(TABLES.SETTINGS)
                    .upsert({ key, value: dbValue }, { onConflict: 'key' });
            });

            const results = await Promise.all(upsertPromises);
            
            // Check for errors
            const errors = results.filter(r => r.error).map(r => r.error.message);
            if (errors.length > 0) {
                throw new Error("Database write failed: " + errors[0]);
            }

            return res.status(200).json({ success: true });

        } catch (e) {
            console.error("PUT Settings Error:", e);
            return res.status(500).json({ error: e.message });
        }
    }
    
    // --- POST: Restore (Rollback) ---
    if (req.method === 'POST') {
        const { logId } = req.body;
        if (!logId) return res.status(400).json({error: "Missing Log ID"});

        try {
            // FIX: Use TABLES.AUDIT
            const { data: log } = await supabaseAdmin.from(TABLES.AUDIT).select('*').eq('id', logId).single();
            if (!log || !log.old_value) throw new Error("Invalid log");

            // Restore
            // FIX: Use TABLES.SETTINGS
            await supabaseAdmin.from(TABLES.SETTINGS).upsert({ 
                key: JSON.parse(log.old_value).key, // Assuming old_value stored key/val structure or we infer it
                value: JSON.parse(log.old_value).value 
            }, { onConflict: 'key' });

            return res.status(200).json({ success: true });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}
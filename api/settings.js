// api/settings.js
import { supabaseAdmin, getUserFromRequest } from './_db.js';

// Helper to safely parse settings that are stored as JSON strings
function parseJsonSettings(settingsFromDb) {
    const parsedSettings = {};
    settingsFromDb.forEach(setting => {
        try {
            // Attempt to parse values for keys we know should be JSON
            if (['themeVariables', 'faviconConfig'].includes(setting.key)) {
                parsedSettings[setting.key] = JSON.parse(setting.value);
            } else {
                parsedSettings[setting.key] = setting.value;
            }
        } catch (e) {
            console.warn(`Could not parse JSON for setting key: ${setting.key}`);
            parsedSettings[setting.key] = setting.value; // Fallback to raw value
        }
    });
    return parsedSettings;
}


export default async function handler(req, res) {

    if (req.method === 'GET') {
        // GET is public, anyone can fetch site settings.
        try {
            const { data, error } = await supabaseAdmin.from('site_settings').select('key, value');
            if (error) throw error;

            const settings = parseJsonSettings(data);
            return res.status(200).json(settings);
        } catch (error) {
            console.error('Error fetching settings:', error.message);
            return res.status(500).json({ error: error.message });
        }
    }

    // For PUT, we require authentication and the 'manager' (god user) role.
    const { user, profile, error: authError } = await getUserFromRequest(req);

    if (authError || !user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Only the 'manager' can change global settings.
    if (profile?.role !== 'manager') {
        return res.status(403).json({ error: 'Forbidden: You do not have permission to change site settings.' });
    }

    if (req.method === 'PUT') {
        const settingsToUpdate = req.body; // e.g., { websiteName: 'New Name', themeVariables: {...} }

        try {
            const updatePromises = Object.entries(settingsToUpdate).map(([key, value]) => {
                // If the value is an object, stringify it for the database 'value' column (which is TEXT).
                const dbValue = typeof value === 'object' ? JSON.stringify(value) : value;

                return supabaseAdmin
                    .from('site_settings')
                    .upsert({ key, value: dbValue }, { onConflict: 'key' }); // Upsert is convenient: updates if key exists, inserts if not.
            });

            const results = await Promise.all(updatePromises);
            const failedUpdates = results.filter(r => r.error);

            if (failedUpdates.length > 0) {
                console.error('Some settings failed to update:', failedUpdates.map(f => f.error.message));
                throw new Error('One or more settings could not be saved.');
            }

            return res.status(200).json({ message: 'Settings updated successfully.' });

        } catch (error) {
            console.error('Error updating settings:', error.message);
            return res.status(500).json({ error: error.message });
        }
    }

    // If method is not GET or PUT
    res.setHeader('Allow', ['GET', 'PUT']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
}
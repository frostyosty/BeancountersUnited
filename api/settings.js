// /api/settings.js
import { supabaseAdmin } from './_db.js';

export default async function handler(req, res) {
    if (req.method === 'GET') {
        try {
            // Fetch all rows from the site_settings table
            const { data, error } = await supabaseAdmin.from('site_settings').select('key, value');

            if (error) {
                // If the table doesn't exist, return an empty object gracefully.
                if (error.code === '42P01') {
                    return res.status(200).json({});
                }
                throw error;
            }

            // --- THE FIX ---
            // Transform the array of rows into a single settings object.
            const settingsObject = data.reduce((acc, row) => {
                try {
                    // Attempt to parse values that should be JSON (like themeVariables)
                    if (['themeVariables', 'ownerPermissions', 'faviconConfig'].includes(row.key)) {
                        acc[row.key] = JSON.parse(row.value);
                    } else {
                        acc[row.key] = row.value;
                    }
                } catch (e) {
                    // If parsing fails, just use the raw string value
                    console.warn(`Could not parse JSON for setting key: ${row.key}`);
                    acc[row.key] = row.value;
                }
                return acc;
            }, {}); // Start with an empty object
            // --- END OF FIX ---

            return res.status(200).json(settingsObject);

        } catch (e) {
            console.error("CRITICAL ERROR in /api/settings:", e);
            return res.status(500).json({ error: "Failed to fetch site settings." });
        }
    }

    // You can add the PUT handler for updating settings back here later.
    // For now, let's just fix the GET.

    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
}
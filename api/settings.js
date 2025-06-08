// /api/settings.js
import { getActiveDbClient, getUserFromRequest, getUserProfile, getSupabaseAdminClient } from './_db.js';

// Helper function to parse JSON values safely
function parseJsonValue(key, value) {
    if (key === 'themeVariables' || key === 'faviconConfig' || key === 'layoutPreferences' || key === 'contentBlocks') { // Add other JSON keys as needed
        try {
            return JSON.parse(value);
        } catch (e) {
            console.warn(`Failed to parse JSON for setting key "${key}":`, e.message, `Raw value: ${value}`);
            return value; // Return raw value if parsing fails
        }
    }
    return value;
}

export default async function handler(req, res) {
    let activeDb;
    try {
        activeDb = await getActiveDbClient();
    } catch (dbError) {
        console.error("Critical: Could not initialize DB client in settings API:", dbError);
        return res.status(500).json({ message: "Database connection error." });
    }
    const { client, type: dbType } = activeDb;

    const user = await getUserFromRequest(req);
    let userProfile = null;
    if (user) {
        try {
            userProfile = await getUserProfile(user.id);
        } catch (profileError) {
            console.warn("Could not fetch profile for authenticated user in settings API:", profileError.message);
            // Allow GET for anyone, but PUT will fail without profile/role
        }
    }

    if (req.method === 'GET') {
        try {
            const defaultSettings = {
                websiteName: "My Awesome Restaurant",
                themeVariables: {},
                faviconConfig: { type: 'default' }, // Default favicon
                currentDbProvider: process.env.ACTIVE_DB_PROVIDER || 'supabase'
            };
            let settingsFromDb = {};

            if (dbType === 'supabase') {
                const { data, error } = await client.from('site_settings').select('key, value');
                // Don't throw if table not found (e.g., first run)
                if (error && error.code !== '42P01' && error.code !== 'PGRST116') { // PGRST116: 'Unknown relation' for empty table/schema issue
                    throw error;
                }
                if (data) {
                    data.forEach(setting => {
                        settingsFromDb[setting.key] = parseJsonValue(setting.key, setting.value);
                    });
                }
            } else if (dbType === 'turso') {
                // Turso logic to fetch all key-value pairs from site_settings
                // const rs = await client.execute("SELECT key, value FROM site_settings;");
                // rs.rows.forEach(row => {
                //     settingsFromDb[row.key] = parseJsonValue(row.key, row.value);
                // });
                console.warn("Turso GET for settings not fully implemented.");
            }

            const combinedSettings = { ...defaultSettings, ...settingsFromDb };
            // Ensure currentDbProvider reflects actual runtime environment if ACTIVE_DB_PROVIDER is set
            combinedSettings.currentDbProvider = process.env.ACTIVE_DB_PROVIDER || defaultSettings.currentDbProvider;

            return res.status(200).json(combinedSettings);

        } catch (error) {
            console.error("Error fetching site settings:", error);
            // Return defaults on error to prevent client breaking, but signal server issue
            return res.status(500).json({ message: `Error fetching settings: ${error.message}`, settings: { websiteName: "My Awesome Restaurant", faviconConfig: { type: 'default' }} });
        }
    } else if (req.method === 'PUT') {
        // Only authenticated users with specific roles can update settings
        if (!userProfile || (userProfile.role !== 'manager' && userProfile.role !== 'owner')) {
            return res.status(403).json({ message: 'Forbidden: Insufficient privileges to update settings.' });
        }

        const updatesToPersist = []; // Array of { key: string, value: string }
        const {
            websiteName,
            themeVariables,
            faviconConfig, // This is the object like { type: 'text', text: 'R', ... }
            faviconImageFileBase64, // Sent by client if uploading image: "data:image/png;base64,iVBORw0KG..."
            faviconImageFileName,   // Original filename for extension and content type inference
            // Add other potential settings from req.body here
            targetDbProvider
        } = req.body;

        // Manager-only settings
        if (userProfile.role === 'manager') {
            if (websiteName !== undefined) {
                updatesToPersist.push({ key: 'websiteName', value: websiteName });
            }
            if (themeVariables !== undefined) {
                updatesToPersist.push({ key: 'themeVariables', value: JSON.stringify(themeVariables) });
            }
            if (targetDbProvider) {
                 console.warn(`Manager requested DB switch to: ${targetDbProvider}. Manual Vercel ENV update and redeploy needed for 'ACTIVE_DB_PROVIDER=${targetDbProvider}'.`);
                 updatesToPersist.push({ key: 'targetDbProvider', value: targetDbProvider }); // Store preference
            }
            // Add other manager-specific settings logic here
        }

        let processedFaviconConfig = faviconConfig; // Will hold the final config for DB

        // Handle Favicon Image Upload (Owner or Manager)
        if (faviconImageFileBase64 && faviconImageFileName && (faviconConfig?.type === 'image' || !faviconConfig) ) {
            try {
                const supabaseAdmin = getSupabaseAdminClient();
                if (!supabaseAdmin) throw new Error("Supabase admin client (for storage) not available.");

                const uniqueFileName = `restaurant-favicon-${Date.now()}.${faviconImageFileName.split('.').pop() || 'png'}`;
                const filePath = `favicons/${uniqueFileName}`;

                const base64Data = faviconImageFileBase64.replace(/^data:image\/[a-zA-Z+.-]+;base64,/, '');
                const imageBuffer = Buffer.from(base64Data, 'base64');
                const contentTypeMatch = faviconImageFileBase64.match(/^data:(image\/[a-zA-Z+.-]+);base64,/);
                const contentType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';

                const { error: uploadError } = await supabaseAdmin.storage
                    .from('public-assets') // Make sure this bucket exists and has appropriate policies
                    .upload(filePath, imageBuffer, { contentType, upsert: false }); // upsert: false because of unique name

                if (uploadError) throw uploadError;

                const { data: publicUrlData } = supabaseAdmin.storage
                    .from('public-assets')
                    .getPublicUrl(filePath);

                if (!publicUrlData || !publicUrlData.publicUrl) {
                    throw new Error("Could not retrieve public URL for uploaded favicon.");
                }
                // This becomes the new faviconConfig
                processedFaviconConfig = { type: 'image', url: publicUrlData.publicUrl };

            } catch (storageError) {
                console.error("Error handling favicon image upload:", storageError);
                return res.status(500).json({ message: `Failed to upload favicon image: ${storageError.message}` });
            }
        }

        // Add faviconConfig to updates (could be from direct input or from image upload)
        if (processedFaviconConfig) { // Can be updated by Owner or Manager
             // Remove any existing faviconConfig from updatesToPersist if image upload happened
            const existingIndex = updatesToPersist.findIndex(u => u.key === 'faviconConfig');
            if (existingIndex > -1) {
                updatesToPersist[existingIndex].value = JSON.stringify(processedFaviconConfig);
            } else {
                updatesToPersist.push({ key: 'faviconConfig', value: JSON.stringify(processedFaviconConfig) });
            }
        }


        if (updatesToPersist.length === 0) {
            return res.status(400).json({ message: 'No valid settings provided to update for your role.' });
        }

        try {
            // Perform database upserts
            for (const setting of updatesToPersist) {
                if (dbType === 'supabase') {
                    const { error: upsertError } = await client
                        .from('site_settings')
                        .upsert(setting, { onConflict: 'key' }); // Assumes 'key' is a unique constrained column
                    if (upsertError) throw upsertError;
                } else if (dbType === 'turso') {
                    // await client.execute({
                    //     sql: "INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                    //     args: [setting.key, setting.value]
                    // });
                    console.warn("Turso PUT for settings not fully implemented.");
                }
            }
            // Return the processed favicon config if it was part of the update for client to use
            const finalFaviconConfigValue = updatesToPersist.find(s => s.key === 'faviconConfig')?.value;

            return res.status(200).json({
                message: 'Settings updated successfully.',
                // Parse it back to an object if it exists for the client
                updatedFaviconConfig: finalFaviconConfigValue ? JSON.parse(finalFaviconConfigValue) : null
            });

        } catch (dbError) {
            console.error('Error saving site settings to database:', dbError);
            return res.status(500).json({ message: `Failed to save settings: ${dbError.message}` });
        }

    } else {
        res.setHeader('Allow', ['GET', 'PUT']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}
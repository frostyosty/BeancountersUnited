// api/menu.js
import { supabaseAdmin } from './_db.js';

export default async function handler(req, res) {
    console.log("--- [API /api/menu] Handler started ---");
    console.log(`[API /api/menu] Request Method: ${req.method}`);

    if (req.method === 'GET') {
        try {
            console.log("[API /api/menu] Attempting to connect to Supabase and query 'menu_items' table...");

            // The database query
            const { data, error, status, statusText } = await supabaseAdmin
                .from('menu_items')
                .select('*')
                .order('name');

            // Log the raw response from Supabase
            console.log("[API /api/menu] Supabase query completed.");
            console.log(`[API /api/menu] Status: ${status} ${statusText}`);
            console.log("[API /api/menu] Error object:", error);
            console.log("[API /api/menu] Data object:", data);

            // Check for errors from the query
            if (error) {
                // Throw the error so it's caught by our catch block
                console.error("[API /api/menu] Supabase query returned an error object.");
                throw error;
            }

            console.log(`[API /api/menu] Successfully fetched ${data.length} items. Sending 200 OK response.`);
            return res.status(200).json(data);

        } catch (e) {
            console.error("[API /api/menu] CRITICAL ERROR in try/catch block:", e);
            return res.status(500).json({
                error: "An internal server error occurred while fetching the menu.",
                details: e.message
            });
        }
    }

    // Handle other methods if necessary
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
}
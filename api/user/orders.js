// /api/user/orders.js
import { supabaseAdmin, getUserFromRequest } from '../_db.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        res.setHeader('Allow', ['GET']);
        return res.status(405).end('Method Not Allowed');
    }

    // This is a protected endpoint. Only a logged-in user can access it.
    const { user, error: authError } = await getUserFromRequest(req);
    if (authError || !user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Fetch all orders that belong to the authenticated user.
        // Also fetch the details of the items for each order (a "join").
        const { data, error } = await supabaseAdmin
            .from('orders')
            .select(`
                id,
                created_at,
                total_amount,
                status,
                order_items (
                    quantity,
                    price_at_order,
                    menu_items ( name, description, image_url, id )
                )
            `)
            .eq('user_id', user.id)
            .order('created_at', { ascending: false }); // Show newest orders first

        if (error) throw error;

        return res.status(200).json(data);

    } catch (error) {
        console.error(`Error fetching orders for user ${user.id}:`, error);
        return res.status(500).json({ error: 'Internal Server Error: Could not fetch order history.' });
    }
}
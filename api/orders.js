// api/orders.js
import { supabaseAdmin } from './_db.js';

export default async function handler(req, res) {
    // We only allow POST requests to this endpoint for creating orders
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).end('Method Not Allowed');
    }

    try {
        const {
            user_id,
            name,
            email,
            phone,
            pickupTime,
            specialRequests,
            items,
            total_amount
        } = req.body;

        // --- Server-side Validation ---
        if (!items || items.length === 0 || !total_amount || !pickupTime || !name || !email) {
            return res.status(400).json({ error: 'Missing required order information.' });
        }

        // Rule: If total is > $10, user_id must be present.
        // This is a basic check; a more robust check would involve getUserFromRequest.
        if (total_amount > 10 && !user_id) {
            return res.status(403).json({ error: 'Login is required for orders over $10.' });
        }

        // --- Database Insertion ---
        // Use a transaction to insert into both 'orders' and 'order_items' tables.
        // This ensures that if one part fails, the whole operation is rolled back.
        const { data: newOrder, error: transactionError } = await supabaseAdmin.rpc('create_new_order', {
            p_user_id: user_id,
            p_customer_name: name,
            p_customer_email: email,
            p_customer_phone: phone,
            p_total_amount: total_amount,
            p_pickup_time: pickupTime,
            p_special_requests: specialRequests,
            p_order_items: items
        });

        if (transactionError) {
            // The error from the RPC function will be more specific
            console.error('Supabase RPC error creating order:', transactionError);
            throw transactionError;
        }

        return res.status(201).json(newOrder);

    } catch (error) {
        console.error('Error in /api/orders handler:', error);
        return res.status(500).json({ error: 'Internal Server Error: Could not place order.' });
    }
}
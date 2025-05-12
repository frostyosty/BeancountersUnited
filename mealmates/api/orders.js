// api/orders.js
import { getActiveDbClient, getUserFromRequest, getUserProfile } from './_db.js';

export default async function handler(req, res) {
    const { client, type } = await getActiveDbClient();
    const user = await getUserFromRequest(req); // For auth on certain actions

    if (req.method === 'POST') {
        // Create a new order
        const { customerName, customerEmail, customerPhone, pickupTime, specialRequests, items, totalAmount, userId } = req.body;

        if (!items || items.length === 0 || !totalAmount || !pickupTime) {
            return res.status(400).json({ message: 'Missing required order information.' });
        }

        // Conditional auth: orders > $10 require login (userId must be present)
        if (parseFloat(totalAmount) > 10 && !userId) {
            // This should also be checked client-side, but good to have server validation
            return res.status(403).json({ message: 'Login required for orders over $10.' });
        }
        
        // If a user is logged in (userId passed from client), ensure it matches the token user
        if (userId && (!user || user.id !== userId)) {
            return res.status(403).json({ message: 'User ID mismatch or authentication invalid.'});
        }


        try {
            let orderResult;
            if (type === 'supabase') {
                // Start a transaction
                // Supabase JS client doesn't directly expose transactions like `BEGIN/COMMIT` in single API calls.
                // You would typically use a Postgres function (RPC) for complex transactions.
                // For this example, we'll do sequential inserts. If one fails, data might be partially inconsistent.
                // A DB Function is the robust way.
                
                const { data: orderData, error: orderError } = await client
                    .from('orders')
                    .insert({
                        user_id: userId || null, // Can be null if < $10 and not logged in
                        customer_name: customerName,
                        customer_email: customerEmail,
                        customer_phone: customerPhone,
                        total_amount: totalAmount,
                        status: 'pending', // Initial status
                        pickup_time: pickupTime,
                        special_requests: specialRequests,
                    })
                    .select()
                    .single();

                if (orderError) throw orderError;

                const orderItemsData = items.map(item => ({
                    order_id: orderData.id,
                    menu_item_id: item.menuItemId,
                    quantity: item.quantity,
                    price_at_order: item.priceAtOrder // Store price at time of order
                }));

                const { error: itemsError } = await client.from('order_items').insert(orderItemsData);
                if (itemsError) {
                    // Attempt to roll back order (delete if items failed) - this is simplistic rollback
                    await client.from('orders').delete().eq('id', orderData.id);
                    throw itemsError;
                }
                orderResult = { ...orderData, items: orderItemsData }; // Combine for response
            
            } else if (type === 'turso') {
                // Turso SDK allows batching for transactions
                const tx = await client.transaction('write');
                try {
                    const orderInsertResult = await tx.execute({
                        sql: `INSERT INTO orders (user_id, customer_name, customer_email, customer_phone, total_amount, status, pickup_time, special_requests) 
                              VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) RETURNING id;`, // RETURNING id works in recent SQLite
                        args: [userId || null, customerName, customerEmail, customerPhone, totalAmount, pickupTime, specialRequests]
                    });
                    
                    const orderId = orderInsertResult.rows[0].id;

                    const itemInserts = items.map(item => ({
                        sql: "INSERT INTO order_items (order_id, menu_item_id, quantity, price_at_order) VALUES (?, ?, ?, ?);",
                        args: [orderId, item.menuItemId, item.quantity, item.priceAtOrder]
                    }));
                    await tx.batch(itemInserts);
                    await tx.commit();

                    // Fetch the full order to return (or just the ID)
                    // This is a simplified representation.
                    orderResult = { id: orderId, /* ...other fields fetched separately or constructed */ };

                } catch (e) {
                    await tx.rollback();
                    throw e;
                }
            }
            return res.status(201).json(orderResult);
        } catch (error) {
            console.error('Error creating order:', error);
            return res.status(500).json({ message: 'Failed to create order', error: error.message });
        }
    } else if (req.method === 'GET') {
        // Get orders (Owner/Manager only)
        let userProfile;
        if (user) userProfile = await getUserProfile(user.id);
        
        if (!userProfile || (userProfile.role !== 'owner' && userProfile.role !== 'manager')) {
            return res.status(403).json({ message: 'Forbidden: Insufficient privileges.' });
        }
        
        try {
            if (type === 'supabase') {
                // Fetch orders, potentially join with user details or order_items
                const { data, error } = await client
                    .from('orders')
                    .select(`
                        *,
                        order_items ( menu_item_id, quantity, price_at_order )
                    `) // Example of fetching related items
                    .order('created_at', { ascending: false })
                    .limit(50); // Paginate in a real app
                if (error) throw error;
                return res.status(200).json(data);
            } else if (type === 'turso') {
                 // For Turso/SQLite, joins would be explicit SQL
                 // This example just gets orders, not items for simplicity
                const rs = await client.execute(
                    "SELECT * FROM orders ORDER BY created_at DESC LIMIT 50;"
                );
                return res.status(200).json(rs.rows);
            }
        } catch (error) {
            console.error('Error fetching orders:', error);
            return res.status(500).json({ message: 'Failed to fetch orders', error: error.message });
        }

    } else {
        res.setHeader('Allow', ['POST', 'GET']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}
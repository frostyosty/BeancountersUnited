import Stripe from 'stripe';

// Initialize Stripe with your Secret Key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { amount } = req.body; // Amount in DOLLARS (e.g. 15.50)

        if (!amount || amount <= 0) {
             return res.status(400).json({ error: "Invalid amount" });
        }

        // Create a PaymentIntent with the order amount and currency
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount * 100), // Stripe expects CENTS (e.g. 1550)
            currency: 'nzd', // or 'usd', 'aud', etc.
            automatic_payment_methods: {
                enabled: true,
            },
        });

        // Send the clientSecret to the frontend
        res.status(200).json({
            clientSecret: paymentIntent.client_secret,
        });

    } catch (e) {
        console.error("Stripe Error:", e);
        res.status(500).json({ error: e.message });
    }
}
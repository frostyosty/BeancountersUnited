// Optional OAuth callback handler
export default async function handler(req, res) {
    console.log("Auth callback received:", req.query);
    res.status(200).json({ message: "Auth callback processed.", query: req.query });
}

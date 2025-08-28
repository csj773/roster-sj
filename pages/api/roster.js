// pages/api/roster.js

export default function handler(req, res) {
    if (req.method === 'GET') {
        // Handle GET request
        res.status(200).json({ message: 'Roster data retrieved successfully' });
    } else if (req.method === 'POST') {
        // Handle POST request
        const newRosterEntry = req.body;
        // Here you would typically save the new entry to a database
        res.status(201).json({ message: 'Roster entry created', data: newRosterEntry });
    } else {
        // Handle any other HTTP method
        res.setHeader('Allow', ['GET', 'POST']);
        res.status(405).end(`Method ${req.method} Not Allowed`);
    }
}
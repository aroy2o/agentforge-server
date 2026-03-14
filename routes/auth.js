const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const queries = require('../database/queries');
const { requireAuth } = require('../middleware/auth');

function generateToken(userId, email) {
    return jwt.sign(
        { userId, email },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
}

// ─── POST /api/auth/register ────────────────────────────────────────────────
router.post('/register', async (req, res) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !name.trim()) return res.status(400).json({ message: 'Name is required' });
        if (!email || !email.trim()) return res.status(400).json({ message: 'Email is required' });
        if (!password || password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

        const normalizedEmail = email.trim().toLowerCase();

        const existing = await queries.findUserByEmail(normalizedEmail);
        if (existing) return res.status(409).json({ message: 'Email already registered' });

        const passwordHash = await bcrypt.hash(password, 12);
        const user = await queries.createUser({ name: name.trim(), email: normalizedEmail, passwordHash });

        // Seed 5 default agents for this new user
        await queries.seedDefaultAgents(user._id.toString());

        const token = generateToken(user._id.toString(), user.email);

        res.status(201).json({
            token,
            user: {
                id: user._id.toString(),
                name: user.name,
                email: user.email,
                createdAt: user.createdAt,
            }
        });
    } catch (err) {
        console.error('[Auth] Register error:', err.message);
        res.status(500).json({ message: 'Registration failed. Please try again.' });
    }
});

// ─── POST /api/auth/login ────────────────────────────────────────────────────
const DUMMY_HASH = '$2a$12$invalidhashfortimingnormalizationxxxxxXXXXX';

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });

        const normalizedEmail = email.trim().toLowerCase();
        const user = await queries.findUserByEmail(normalizedEmail);

        // Even if user not found, run bcrypt to prevent timing attacks
        const hashToCompare = user ? user.passwordHash : DUMMY_HASH;
        const match = await bcrypt.compare(password, hashToCompare);

        if (!user || !match) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = generateToken(user._id.toString(), user.email);

        res.json({
            token,
            user: {
                id: user._id.toString(),
                name: user.name,
                email: user.email,
                createdAt: user.createdAt,
                preferences: user.preferences,
            }
        });
    } catch (err) {
        console.error('[Auth] Login error:', err.message);
        res.status(500).json({ message: 'Login failed. Please try again.' });
    }
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await queries.findUserById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ user });
    } catch (err) {
        console.error('[Auth] /me error:', err.message);
        res.status(500).json({ message: 'Failed to fetch user' });
    }
});

router.put('/change-password', requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Current password and new password are required' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: 'New password must be at least 6 characters' });
        }

        const User = require('../database/models/User');
        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });

        const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!isMatch) return res.status(401).json({ message: 'Current password is incorrect' });

        user.passwordHash = await bcrypt.hash(newPassword, 12);
        await user.save();

        return res.json({ success: true });
    } catch (err) {
        return res.status(500).json({ message: 'Failed to change password' });
    }
});

module.exports = router;

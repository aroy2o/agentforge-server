const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const queries = require('../database/queries');

// All routes in this file require authentication
router.use(requireAuth);

// ─── AGENTS ──────────────────────────────────────────────────────────────────

router.get('/agents', async (req, res) => {
    try {
        const Agent = require('../database/models/Agent');
        let agents = await queries.getAgentsByUser(req.user.userId);

        const VALID_DEFAULT_NAMES = ['Scout', 'Quill', 'Sage', 'Atlas', 'Max'];
        const VALID_DEFAULT_IDS = ['agent-scout', 'agent-quill', 'agent-sage', 'agent-atlas', 'agent-max'];

        // Step 1: Purge stale default agents that no longer belong to the current 5
        const hasStaleAgents = agents.some(a =>
            a.isDefault &&
            !VALID_DEFAULT_NAMES.includes(a.name) &&
            !VALID_DEFAULT_IDS.includes(a._id.toString())
        );

        if (hasStaleAgents) {
            console.log('[Agents] Stale agents detected. Purging DB for user:', req.user.userId);
            await Agent.deleteMany({ userId: req.user.userId });
            await queries.seedDefaultAgents(req.user.userId);
            agents = await queries.getAgentsByUser(req.user.userId);
        }

        // Step 2: Deduplicate by name — one agent per name, prefer isDefault, then earliest createdAt
        const nameMap = new Map();
        for (const agent of agents) {
            const key = agent.name.toLowerCase();
            if (!nameMap.has(key)) {
                nameMap.set(key, agent);
            } else {
                const existing = nameMap.get(key);
                // Prefer the isDefault version; if tied, prefer earliest createdAt
                if (agent.isDefault && !existing.isDefault) {
                    nameMap.set(key, agent);
                } else if (!agent.isDefault && !existing.isDefault) {
                    const agentDate = new Date(agent.createdAt || 0);
                    const existingDate = new Date(existing.createdAt || 0);
                    if (agentDate < existingDate) nameMap.set(key, agent);
                }
            }
        }

        const deduplicated = Array.from(nameMap.values());

        // Step 3: Delete the losers from MongoDB
        const keepIds = new Set(deduplicated.map(a => a._id.toString()));
        const duplicateIds = agents
            .filter(a => !keepIds.has(a._id.toString()))
            .map(a => a._id);

        if (duplicateIds.length > 0) {
            console.log(`[Agents] Removing ${duplicateIds.length} duplicate agents for user:`, req.user.userId);
            await Agent.deleteMany({ _id: { $in: duplicateIds } });
        }

        res.json({ agents: deduplicated });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});


router.post('/agents', async (req, res) => {
    try {
        const agent = await queries.createAgent({ ...req.body, userId: req.user.userId });
        res.status(201).json({ agent });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/agents/reset', async (req, res) => {
    try {
        const Agent = require('../database/models/Agent');
        await Agent.deleteMany({ userId: req.user.userId });
        await queries.seedDefaultAgents(req.user.userId);
        const agents = await queries.getAgentsByUser(req.user.userId);
        res.json({ agents });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.put('/agents/:id', async (req, res) => {
    try {
        const agent = await queries.updateAgent(req.params.id, req.user.userId, req.body);
        if (!agent) return res.status(404).json({ message: 'Agent not found or not owned by you' });
        res.json({ agent });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.delete('/agents/:id', async (req, res) => {
    try {
        await queries.deleteAgent(req.params.id, req.user.userId);
        res.json({ message: 'Agent deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─── PIPELINE ─────────────────────────────────────────────────────────────────

router.get('/pipeline', async (req, res) => {
    try {
        const pipeline = await queries.getPipelineByUser(req.user.userId);
        res.json({ pipeline });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.put('/pipeline', async (req, res) => {
    try {
        const { agentOrder = [] } = req.body;
        const pipeline = await queries.savePipeline(req.user.userId, agentOrder);
        res.json({ pipeline });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─── COMPLETED TASKS ──────────────────────────────────────────────────────────

router.get('/tasks', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const tasks = await queries.getCompletedTasksByUser(req.user.userId, limit);
        res.json({ tasks });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/tasks', async (req, res) => {
    try {
        const task = await queries.saveCompletedTask({ ...req.body, userId: req.user.userId });
        res.status(201).json({ task });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.delete('/tasks/:id', async (req, res) => {
    try {
        await queries.deleteCompletedTask(req.params.id, req.user.userId);
        res.json({ message: 'Task deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─── SCHEDULES ─────────────────────────────────────────────────────────────────

router.get('/schedules', async (req, res) => {
    try {
        const Schedule = require('../database/models/Schedule');
        const schedules = await Schedule.find({ userId: req.user.userId }).sort({ createdAt: -1 });
        res.json({ schedules });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.delete('/schedules/:id', async (req, res) => {
    try {
        const Schedule = require('../database/models/Schedule');
        const schedulerService = require('../services/schedulerService');
        const deleted = await Schedule.findOneAndDelete({ _id: req.params.id, userId: req.user.userId });
        if (deleted) schedulerService.stopSchedule(deleted._id);
        res.json({ message: 'Schedule deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─── PREFERENCES ──────────────────────────────────────────────────────────────

router.get('/preferences', async (req, res) => {
    try {
        const user = await queries.findUserById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ preferences: user.preferences || {} });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.put('/preferences', async (req, res) => {
    try {
        const { theme, language, voiceEnabled } = req.body;
        const user = await queries.updatePreferences(req.user.userId, { theme, language, voiceEnabled });
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ preferences: user.preferences || {} });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;

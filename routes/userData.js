const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const queries = require('../database/queries');
const { DEFAULT_AGENT_TEMPLATES } = require('../database/queries');

// All routes in this file require authentication
router.use(requireAuth);

// ─── AGENTS ──────────────────────────────────────────────────────────────────

router.get('/agents', async (req, res) => {
    try {
        const Agent = require('../database/models/Agent');
        let agents = await queries.getAgentsByUser(req.user.userId);

        const VALID_DEFAULT_NAMES = ['Forge', 'Scout', 'Quill', 'Sage', 'Atlas', 'Lens', 'Hermes'];
        const VALID_DEFAULT_IDS = ['agent-forge', 'agent-scout', 'agent-quill', 'agent-sage', 'agent-atlas', 'agent-lens', 'agent-hermes'];

        // Step 1: Purge stale default agents that no longer belong to the current 5
        const hasStaleAgents = agents.some(a =>
            a.isDefault &&
            !VALID_DEFAULT_NAMES.includes(a.name) &&
            !VALID_DEFAULT_IDS.includes((a.id || '').toString())
        );

        if (hasStaleAgents) {
            console.log('[Agents] Stale agents detected. Purging DB for user:', req.user.userId);
            await Agent.deleteMany({ userId: req.user.userId });
            await queries.seedDefaultAgents(req.user.userId);
            agents = await queries.getAgentsByUser(req.user.userId);
        }

        const existingNames = new Set(agents.map((a) => String(a.name || '').toLowerCase()));
        const missingDefaults = DEFAULT_AGENT_TEMPLATES.filter((template) => !existingNames.has(String(template.name || '').toLowerCase()));

        if (missingDefaults.length > 0) {
            for (const template of missingDefaults) {
                await queries.createAgent({ ...template, userId: req.user.userId, isDefault: true });
            }
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

router.post('/agents/sync-all', async (req, res) => {
    try {
        const Agent = require('../database/models/Agent');
        const names = ['Forge', 'Scout', 'Quill', 'Sage', 'Atlas', 'Lens', 'Hermes'];
        const templatesByName = new Map(
            DEFAULT_AGENT_TEMPLATES
                .filter((t) => names.includes(t.name))
                .map((t) => [t.name, t])
        );

        for (const name of names) {
            const template = templatesByName.get(name);
            if (!template || !template.personality) continue;

            await Agent.updateMany(
                { name },
                { $set: { personality: template.personality } }
            );
        }

        res.json({ success: true });
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

router.patch('/schedules/:id', async (req, res) => {
    try {
        const Schedule = require('../database/models/Schedule');
        const schedulerService = require('../services/schedulerService');
        const { isActive } = req.body || {};

        if (typeof isActive !== 'boolean') {
            return res.status(400).json({ message: 'isActive must be a boolean' });
        }

        const schedule = await Schedule.findById(req.params.id);
        if (!schedule || String(schedule.userId) !== String(req.user.userId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        schedule.isActive = isActive;
        await schedule.save();

        if (!isActive) {
            schedulerService.stopSchedule(schedule._id);
        } else {
            schedulerService.scheduleJob(schedule.toObject());
        }

        res.json({ schedule });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/schedules/:id/run-now', async (req, res) => {
    try {
        const Schedule = require('../database/models/Schedule');
        const schedulerService = require('../services/schedulerService');

        const schedule = await Schedule.findById(req.params.id).lean();
        if (!schedule || String(schedule.userId) !== String(req.user.userId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        await schedulerService.runJobNow(schedule);
        res.json({ success: true, message: 'Schedule executed immediately' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.get('/schedules/:id/history', async (req, res) => {
    try {
        const Schedule = require('../database/models/Schedule');
        const ScheduleHistory = require('../database/models/ScheduleHistory');

        const schedule = await Schedule.findById(req.params.id).lean();
        if (!schedule || String(schedule.userId) !== String(req.user.userId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const history = await ScheduleHistory.find({ scheduleId: String(req.params.id) })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();

        res.json({ history });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ─── PREFERENCES ──────────────────────────────────────────────────────────────

router.get('/preferences', async (req, res) => {
    try {
        const user = await queries.findUserById(req.user.userId);
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({
            preferences: user.preferences || {},
            notifications: user.notifications || {},
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.put('/preferences', async (req, res) => {
    try {
        const User = require('../database/models/User');
        const incoming = req.body || {};
        const allowed = [
            'theme',
            'language',
            'voiceEnabled',
            'showPipelineRecommendations',
            'showEmailField',
            'autoSendEmail',
            'voiceEnabledByDefault',
            'autoOptimisePrompts',
        ];

        const update = {};
        for (const key of allowed) {
            if (incoming[key] !== undefined) update[`preferences.${key}`] = incoming[key];
        }

        const user = await User.findByIdAndUpdate(
            req.user.userId,
            { $set: update },
            { returnDocument: 'after', lean: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ preferences: user.preferences || {} });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.put('/preferences/notifications', async (req, res) => {
    try {
        const User = require('../database/models/User');
        const incoming = req.body || {};
        console.log('[Preferences Notifications] userId:', req.user.userId, 'payload:', incoming);
        const allowed = [
            'emailEnabled',
            'emailAddress',
            'notifyOnPipelineComplete',
            'notifyOnScheduledTask',
            'notifyOnCalendarCreated',
            'voiceControlEnabled',
            'voiceContinuousMode',
            'voiceMuted',
            'voiceRate',
            'voicePitch',
            'voiceRecognitionLanguage',
            'voiceOnboarded',
        ];

        const update = {};
        for (const key of allowed) {
            if (incoming[key] !== undefined) update[`notifications.${key}`] = incoming[key];
        }

        const user = await User.findByIdAndUpdate(
            req.user.userId,
            { $set: update },
            { returnDocument: 'after', lean: true }
        );
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json({ notifications: user.notifications || {} });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.delete('/memory', async (req, res) => {
    try {
        const AgentMemory = require('../database/models/AgentMemory');
        await AgentMemory.deleteMany({ userId: req.user.userId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.delete('/account', async (req, res) => {
    try {
        const User = require('../database/models/User');
        const Agent = require('../database/models/Agent');
        const Pipeline = require('../database/models/Pipeline');
        const CompletedTask = require('../database/models/CompletedTask');
        const AgentMemory = require('../database/models/AgentMemory');
        const Schedule = require('../database/models/Schedule');
        const ScheduleHistory = require('../database/models/ScheduleHistory');
        const ChatSession = require('../database/models/ChatSession');
        const PermissionRequest = require('../database/models/PermissionRequest');

        const userId = req.user.userId;
        await Promise.all([
            Agent.deleteMany({ userId }),
            Pipeline.deleteMany({ userId }),
            CompletedTask.deleteMany({ userId }),
            AgentMemory.deleteMany({ userId }),
            Schedule.deleteMany({ userId }),
            ScheduleHistory.deleteMany({ userId }),
            ChatSession.deleteMany({ userId }),
            PermissionRequest.deleteMany({ fromUserId: userId }),
            User.deleteOne({ _id: userId }),
        ]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;

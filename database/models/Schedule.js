const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    agentIds: { type: [String], default: [] },
    pipeline: {
        type: [
            {
                agentId: { type: String, required: true },
                agentName: { type: String, default: '' },
                agentColor: { type: String, default: '' },
            },
        ],
        default: [],
    },
    taskGoal: { type: String, required: true },
    cronExpression: { type: String, required: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    lastRunAt: { type: Date },
    nextRunAt: { type: Date },
    runCount: { type: Number, default: 0 },
    lastRunStatus: { type: String, enum: ['success', 'failed'], default: null },
    lastError: { type: String, default: null },
    lastErrorAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Schedule', scheduleSchema);

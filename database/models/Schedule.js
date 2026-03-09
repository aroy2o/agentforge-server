const mongoose = require('mongoose');

const scheduleSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    agentIds: { type: [String], default: [] },
    taskGoal: { type: String, required: true },
    cronExpression: { type: String, required: true },
    timezone: { type: String, default: 'Asia/Kolkata' },
    email: { type: String, default: '' },
    phone: { type: String, default: '' },
    isActive: { type: Boolean, default: true },
    lastRunAt: { type: Date },
    nextRunAt: { type: Date },
    runCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Schedule', scheduleSchema);

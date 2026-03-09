const mongoose = require('mongoose');

const agentMemorySchema = new mongoose.Schema({
    agentId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    taskGoal: { type: String },
    summary: { type: String },
    fullOutput: { type: String },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('AgentMemory', agentMemorySchema);

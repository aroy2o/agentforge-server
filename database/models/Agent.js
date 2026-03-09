const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    role: { type: String, required: true },
    personality: { type: String, default: '' },
    tools: { type: [String], default: [] },
    color: { type: String, default: '#00d4ff' },
    isDefault: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Agent', agentSchema);

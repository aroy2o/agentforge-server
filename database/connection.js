const mongoose = require('mongoose');

mongoose.set('strictQuery', false);

async function connectDB() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('[Database] Connected to MongoDB Atlas ✓');
    } catch (error) {
        console.error('[Database] Connection failed:', error.message);
        process.exit(1);
    }
}

module.exports = { connectDB };

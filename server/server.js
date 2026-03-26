require('dotenv').config();
require('express-async-errors');
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const Team = require('./models/Team');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ─── SECURITY MIDDLEWARE ─────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
    contentSecurityPolicy: isProduction ? {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
            connectSrc: ["'self'", process.env.CLIENT_URL || 'http://localhost:3000']
        }
    } : false,
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false
}));

app.use(cors({
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(hpp());
app.use(compression());

if (process.env.NODE_ENV !== 'production') {
    app.use(morgan('dev'));
}

// ─── RATE LIMITING ───────────────────────────────────────────
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { error: 'TOO_MANY_REQUESTS' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use('/api/', generalLimiter);

// ─── SOCKET.IO ───────────────────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: process.env.CLIENT_URL || 'http://localhost:3000',
        credentials: true
    }
});

app.set('io', io);

// Initialize socket handler
const initSocketHandler = require('./socket/socketHandler');
initSocketHandler(io);

// ─── ROUTES ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/team', require('./routes/team'));
app.use('/api/leaderboard', require('./routes/leaderboard'));
app.use('/api/admin', require('./routes/admin'));

// QM routes with env-driven prefix
const QM_PREFIX = process.env.API_QM_PREFIX || 'v2/sys/qm';
app.use(`/api/${QM_PREFIX}`, require('./routes/questionManager'));

// ─── ERROR HANDLER ───────────────────────────────────────────
app.use(errorHandler);

// ─── DATABASE + SERVER START ─────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        logger.info('MongoDB connected');

        // Auto-lock teams whose grace period expired while server was down
        const result = await Team.updateMany(
            { lockoutStatus: 'ACTIVE', graceExpiresAt: { $lt: new Date(), $ne: null } },
            { lockoutStatus: 'LOCKED', lockReason: 'CONNECTIVITY_LOSS', lockedAt: new Date() }
        );
        if (result.modifiedCount > 0) {
            logger.info(`Auto-locked ${result.modifiedCount} teams with expired grace periods`);
        }

        server.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
        });
    })
    .catch((err) => {
        logger.error('MongoDB connection error:', err);
        process.exit(1);
    });

module.exports = app;

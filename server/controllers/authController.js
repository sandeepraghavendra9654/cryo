const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Team = require('../models/Team');
const Admin = require('../models/Admin');
const AdminSession = require('../models/AdminSession');
const logger = require('../utils/logger');
const { INPUT_LIMITS } = require('../config/config');

const generateToken = (payload) => {
    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || '8h'
    });
};

const setAuthCookie = (res, token) => {
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('auth_token', token, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 8 * 60 * 60 * 1000,
        ...(isProduction && process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN })
    });
};

const setQmgrCookie = (res, qmgrToken) => {
    const isProduction = process.env.NODE_ENV === 'production';
    res.cookie('qmgr_token', qmgrToken, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 2 * 60 * 60 * 1000,
        ...(isProduction && process.env.COOKIE_DOMAIN && { domain: process.env.COOKIE_DOMAIN })
    });
};

// POST /api/auth/register
exports.register = async (req, res) => {
    const { teamName, password, participants } = req.body;

    // Validate team name
    if (!teamName || !/^[a-zA-Z0-9_]+$/.test(teamName) || teamName.length > INPUT_LIMITS.TEAM_NAME_MAX) {
        return res.status(400).json({ error: 'INVALID_TEAM_NAME', message: 'Alphanumeric and underscore only, max 30 chars' });
    }

    // Validate password
    if (!password || password.length < INPUT_LIMITS.PASSWORD_MIN || password.length > INPUT_LIMITS.PASSWORD_MAX) {
        return res.status(400).json({ error: 'INVALID_PASSWORD', message: 'Password must be 8-64 characters' });
    }

    // Validate participants
    if (!participants || !Array.isArray(participants) || participants.length < 1 || participants.length > 3) {
        return res.status(400).json({ error: 'INVALID_PARTICIPANTS', message: 'Team must have 1-3 participants' });
    }

    for (const p of participants) {
        if (!p.name || !p.registerNumber) {
            return res.status(400).json({ error: 'INVALID_PARTICIPANT_DATA', message: 'Each participant needs name and register number' });
        }
        if (!/^[a-zA-Z0-9]+$/.test(p.registerNumber) || p.registerNumber.length > INPUT_LIMITS.REGISTER_NUMBER_MAX) {
            return res.status(400).json({ error: 'INVALID_REGISTER_NUMBER', message: 'Register number: alphanumeric only, max 15 chars' });
        }
    }

    // Check existing
    const existing = await Team.findOne({ teamName });
    if (existing) {
        return res.status(409).json({ error: 'TEAM_EXISTS', message: 'Team name already taken' });
    }

    const team = await Team.create({
        teamName,
        passwordHash: password, // pre('save') hook hashes it
        participants,
        approvalStatus: 'PENDING'
    });

    // Emit to admin via Socket.io
    const io = req.app.get('io');
    if (io) {
        io.to('admin').emit('team:registered', {
            teamId: team._id,
            teamName: team.teamName,
            memberCount: team.participants.length
        });
    }

    // Issue limited JWT for pending page
    const token = generateToken({
        teamId: team._id,
        teamName: team.teamName,
        role: 'team',
        approvalStatus: 'PENDING',
        lockoutStatus: 'ACTIVE'
    });

    setAuthCookie(res, token);

    res.status(201).json({
        message: 'REGISTRATION_SUCCESSFUL',
        team: {
            teamName: team.teamName,
            approvalStatus: 'PENDING',
            participantCount: team.participants.length
        }
    });
};

// POST /api/auth/login
exports.login = async (req, res) => {
    const { teamName, password } = req.body;

    if (!teamName || !password) {
        return res.status(400).json({ error: 'MISSING_CREDENTIALS' });
    }

    const team = await Team.findOne({ teamName }).select('+passwordHash');
    if (!team) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }

    const isMatch = await team.comparePassword(password);
    if (!isMatch) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }

    const token = generateToken({
        teamId: team._id,
        teamName: team.teamName,
        role: 'team',
        approvalStatus: team.approvalStatus,
        lockoutStatus: team.lockoutStatus
    });

    setAuthCookie(res, token);

    // Determine redirect
    let redirect = '/pending';
    if (team.approvalStatus === 'APPROVED') redirect = '/dashboard';
    if (team.approvalStatus === 'REJECTED') redirect = '/login';

    res.json({
        message: 'LOGIN_SUCCESSFUL',
        approvalStatus: team.approvalStatus,
        lockoutStatus: team.lockoutStatus,
        redirect,
        rejectionReason: team.approvalStatus === 'REJECTED' ? team.rejectionReason : undefined
    });
};

// POST /api/auth/logout
exports.logout = (req, res) => {
    res.clearCookie('auth_token');
    res.clearCookie('qmgr_token');
    res.json({ message: 'LOGOUT_SUCCESSFUL' });
};

// GET /api/auth/approval-status
exports.approvalStatus = async (req, res) => {
    const team = await Team.findById(req.teamId);
    if (!team) {
        return res.status(404).json({ error: 'TEAM_NOT_FOUND' });
    }

    res.json({
        approvalStatus: team.approvalStatus,
        rejectionReason: team.rejectionReason,
        lockoutStatus: team.lockoutStatus
    });
};

// POST /api/auth/refresh-token
exports.refreshToken = async (req, res) => {
    const team = await Team.findById(req.teamId);
    if (!team) {
        return res.status(404).json({ error: 'TEAM_NOT_FOUND' });
    }

    const token = generateToken({
        teamId: team._id,
        teamName: team.teamName,
        role: 'team',
        approvalStatus: team.approvalStatus,
        lockoutStatus: team.lockoutStatus
    });

    setAuthCookie(res, token);

    res.json({
        message: 'TOKEN_REFRESHED',
        approvalStatus: team.approvalStatus,
        lockoutStatus: team.lockoutStatus
    });
};

// POST /api/admin/login
exports.adminLogin = async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'MISSING_CREDENTIALS' });
    }

    const admin = await Admin.findOne({ username }).select('+passwordHash');
    if (!admin) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    }

    // Generate admin JWT
    const token = generateToken({
        adminId: admin._id,
        username: admin.username,
        role: 'admin'
    });

    // Generate QMGR session token
    const qmgrToken = crypto.randomBytes(32).toString('hex');
    await AdminSession.create({
        adminId: admin._id,
        adminUsername: admin.username,
        qmgrToken
    });

    setAuthCookie(res, token);
    setQmgrCookie(res, qmgrToken);

    res.json({
        message: 'ADMIN_LOGIN_SUCCESSFUL',
        username: admin.username
    });
};

// POST /api/admin/logout
exports.adminLogout = (req, res) => {
    res.clearCookie('auth_token');
    res.clearCookie('qmgr_token');
    res.json({ message: 'ADMIN_LOGOUT_SUCCESSFUL' });
};

// POST /api/admin/logout-qmgr
exports.logoutQmgr = async (req, res) => {
    const token = req.cookies.qmgr_token;
    if (token) {
        await AdminSession.findOneAndUpdate(
            { qmgrToken: token },
            { isRevoked: true }
        );
    }
    res.clearCookie('qmgr_token');
    res.json({ message: 'QMGR_SESSION_REVOKED' });
};

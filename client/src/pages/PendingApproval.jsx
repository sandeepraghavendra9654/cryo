import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import api from '../utils/api';
import GlitchText from '../components/GlitchText';
import TerminalCard from '../components/TerminalCard';
import ApprovalStatusBadge from '../components/ApprovalStatusBadge';
import { useSocket } from '../context/SocketContext';
import { useAuth } from '../context/AuthContext';

const PendingApproval = () => {
    const navigate = useNavigate();
    const { socket } = useSocket();
    const { checkAuth } = useAuth();
    const [status, setStatus] = useState(null);
    const [rejectionReason, setRejectionReason] = useState(null);
    const [checking, setChecking] = useState(true);

    const checkApproval = async () => {
        try {
            const res = await api.get('/auth/approval-status');
            setStatus(res.data.approvalStatus);
            setRejectionReason(res.data.rejectionReason);
            return res.data.approvalStatus;
        } catch {
            return null;
        } finally {
            setChecking(false);
        }
    };

    const handleApproved = React.useCallback(async () => {
        try {
            const res = await api.post('/auth/refresh-token');
            // Save the refreshed token with APPROVED status
            if (res.data.token) {
                localStorage.setItem('auth_token', res.data.token);
            }
            // Re-check auth so AuthContext updates user state to APPROVED
            await checkAuth();
        } catch {}
        navigate('/dashboard', { replace: true });
    }, [navigate, checkAuth]);

    // Check immediately on mount (handles page reload)
    useEffect(() => {
        checkApproval().then(s => {
            if (s === 'APPROVED') handleApproved();
        });
    }, [navigate, handleApproved]);

    // Poll every 5 seconds
    useEffect(() => {
        const interval = setInterval(async () => {
            const s = await checkApproval();
            if (s === 'APPROVED') {
                clearInterval(interval);
                setTimeout(() => handleApproved(), 1000);
            }
        }, 5000);
        return () => clearInterval(interval);
    }, [navigate, handleApproved]);

    // Socket listener for instant approval notification
    useEffect(() => {
        if (!socket) return;
        socket.on('approval:granted', () => {
            setStatus('APPROVED');
            setTimeout(() => handleApproved(), 1500);
        });
        socket.on('approval:rejected', () => {
            checkApproval();
        });
        return () => {
            socket.off('approval:granted');
            socket.off('approval:rejected');
        };
    }, [socket, navigate, handleApproved]);

    if (checking) {
        return (
            <div className="min-h-screen bg-hacker-black flex items-center justify-center">
                <div className="text-neon-green"><span className="terminal-spinner"></span> CHECKING STATUS...</div>
            </div>
        );
    }

    if (status === 'APPROVED') {
        return (
            <div className="min-h-screen bg-hacker-black relative">
                <div className="relative z-10 flex items-center justify-center min-h-screen px-4">
                    <TerminalCard title="[✓ ACCESS GRANTED]" className="max-w-lg w-full">
                        <div className="text-center space-y-4">
                            <h2 className="text-neon-green text-2xl font-bold">APPROVED</h2>
                            <ApprovalStatusBadge status="APPROVED" />
                            <p className="text-electric-cyan text-sm animate-pulse">Redirecting to dashboard...</p>
                        </div>
                    </TerminalCard>
                </div>
            </div>
        );
    }

    if (status === 'REJECTED') {
        return (
            <div className="min-h-screen bg-hacker-black relative">
                <div className="relative z-10 flex items-center justify-center min-h-screen px-4">
                    <TerminalCard title="[✗ ACCESS DENIED]" className="max-w-lg w-full">
                        <div className="text-center space-y-4">
                            <h2 className="text-danger-red text-2xl font-bold">REGISTRATION REJECTED</h2>
                            <ApprovalStatusBadge status="REJECTED" />
                            {rejectionReason && (
                                <p className="text-neon-green opacity-70 text-sm">Reason: {rejectionReason}</p>
                            )}
                            <button onClick={() => navigate('/login')} className="btn-danger">RETURN_TO_LOGIN</button>
                        </div>
                    </TerminalCard>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-hacker-black relative">
            <div className="relative z-10 flex items-center justify-center min-h-screen px-4">
                <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>
                    <TerminalCard title="[AWAITING AUTHORIZATION]" className="max-w-lg w-full">
                        <div className="text-center space-y-6">
                            <GlitchText text="PENDING APPROVAL" tag="h2" className="text-2xl text-warning-yellow" />
                            <ApprovalStatusBadge status="PENDING" />
                            <div className="text-neon-green text-sm space-y-2 opacity-70">
                                <p>{'>'} Registration submitted successfully</p>
                                <p>{'>'} Waiting for admin authorization...</p>
                                <p className="animate-pulse">{'>'} Polling server every 5 seconds█</p>
                            </div>
                            <div className="border-t border-terminal-border pt-4 text-xs text-electric-cyan opacity-50">
                                You will be automatically redirected to login when approved
                            </div>
                        </div>
                    </TerminalCard>
                </motion.div>
            </div>
        </div>
    );
};

export default PendingApproval;

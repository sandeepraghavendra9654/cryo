import React, { createContext, useContext, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext(null);

export const useSocket = () => useContext(SocketContext);

export const SocketProvider = ({ children }) => {
    const [socket, setSocket] = useState(null);
    const [connected, setConnected] = useState(false);
    const { user } = useAuth();

    // Use a stable key to avoid reconnecting on every user reference change
    const userKey = user ? `${user.role}:${user.teamName || user.username || ''}` : null;

    useEffect(() => {
        if (!userKey) {
            if (socket) {
                socket.disconnect();
                setSocket(null);
                setConnected(false);
            }
            return;
        }

        const socketUrl = process.env.REACT_APP_SOCKET_URL || 'http://localhost:5000';

        const token = localStorage.getItem('auth_token');

        const newSocket = io(socketUrl, {
            auth: { token },
            withCredentials: true,
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000
        });

        newSocket.on('connect', () => {
            setConnected(true);
        });

        newSocket.on('disconnect', () => {
            setConnected(false);
        });

        setSocket(newSocket);

        return () => {
            newSocket.disconnect();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userKey]);

    return (
        <SocketContext.Provider value={{ socket, connected }}>
            {children}
        </SocketContext.Provider>
    );
};

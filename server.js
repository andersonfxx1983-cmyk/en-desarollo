// server.js - Backend centralizado y seguro para Aria Gold Casino
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname))); 

// Base de datos en memoria
let db = {
    users: {},
    globalMultiplier: 1
};

const ADMIN_PASS = "admin123";
const INITIAL_BALANCE = 150000;

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'UPDATE_STATE', db }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'USER_REGISTER') {
                const { username, password } = data;
                if (!username || !password || username.trim() === '') {
                    return ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: false, message: '❌ Datos inválidos.' }));
                }
                if (db.users[username]) {
                    return ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: false, message: '❌ El usuario ya existe.' }));
                }
                
                let newUid;
                do {
                    newUid = Math.floor(100000 + Math.random() * 900000).toString();
                } while (Object.values(db.users).some(u => u.uid === newUid));

                db.users[username] = {
                    password,
                    uid: newUid,
                    balance: INITIAL_BALANCE,
                    banned: false,
                    banReason: '',
                    banExpires: 0
                };
                
                ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: true, username, balance: INITIAL_BALANCE, uid: newUid }));
                broadcast({ type: 'UPDATE_STATE', db });
            }
            
            else if (data.type === 'USER_LOGIN') {
                const { username, password } = data;
                const user = db.users[username];
                
                if (!user || user.password !== password) {
                    return ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: false, message: '❌ Usuario o contraseña incorrectos.' }));
                }
                
                if (user.banned && user.banExpires !== -1 && Date.now() > user.banExpires) {
                    user.banned = false;
                    user.banReason = '';
                    user.banExpires = 0;
                    broadcast({ type: 'UPDATE_STATE', db });
                }

                if (user.banned) {
                    return ws.send(JSON.stringify({ type: 'BANNED_RESPONSE', user, username }));
                }
                
                ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: true, username, balance: user.balance, uid: user.uid }));
            }
            
            else if (data.type === 'MAKE_TRANSFER') {
                const { senderUsername, recipientUid, amount } = data;
                const amt = parseInt(amount);
                const sender = db.users[senderUsername];
                let recipientUsername = Object.keys(db.users).find(u => db.users[u].uid === recipientUid);

                if (!sender || !recipientUsername || senderUsername === recipientUsername || isNaN(amt) || amt <= 0 || sender.balance < amt) {
                    return ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: false, message: '❌ Transferencia inválida o saldo insuficiente.' }));
                }

                sender.balance -= amt;
                db.users[recipientUsername].balance += amt;

                ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: true, newBalance: sender.balance, message: `✅ ¡Enviaste $${amt.toLocaleString()} COP a ${recipientUsername}!` }));
                broadcast({ type: 'UPDATE_STATE', db });
            }

            else if (data.type === 'ADMIN_MODIFY_BALANCE') {
                if (data.adminPass !== ADMIN_PASS) return ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: false, message: '❌ Contraseña admin incorrecta.' }));
                
                const { target, action, amount } = data;
                const amt = parseInt(amount);
                
                if (isNaN(amt) || amt <= 0) return ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: false, message: '❌ Monto inválido.' }));

                let targetKey = Object.keys(db.users).find(u => u === target || db.users[u].uid === target);
                if (!targetKey) return ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: false, message: '❌ Usuario no encontrado.' }));
                
                if (action === 'add') {
                    db.users[targetKey].balance += amt;
                } else {
                    db.users[targetKey].balance = Math.max(0, db.users[targetKey].balance - amt);
                }
                
                ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: true, message: `✅ Saldo de ${targetKey} actualizado.` }));
                broadcast({ type: 'UPDATE_STATE', db });
            }

            else if (data.type === 'ADMIN_BAN_USER') {
                if (data.adminPass !== ADMIN_PASS) return;
                const { target, reason, expireTime } = data;
                let targetKey = Object.keys(db.users).find(u => u === target || db.users[u].uid === target);
                
                if (!targetKey) return ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: false, message: '❌ Usuario no encontrado.' }));
                
                db.users[targetKey].banned = true;
                db.users[targetKey].banReason = reason || "Violación de normas del casino.";
                db.users[targetKey].banExpires = expireTime;
                
                ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: true, message: `⛔ Usuario ${targetKey} baneado.` }));
                broadcast({ type: 'UPDATE_STATE', db });
            }

            else if (data.type === 'ADMIN_UNBAN_USER') {
                if (data.adminPass !== ADMIN_PASS) return;
                let targetKey = Object.keys(db.users).find(u => u === data.target || db.users[u].uid === data.target);
                
                if (!targetKey) return ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: false, message: '❌ Usuario no encontrado.' }));
                
                db.users[targetKey].banned = false;
                db.users[targetKey].banReason = '';
                db.users[targetKey].banExpires = 0;
                
                ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: true, message: `✅ Usuario ${targetKey} desbaneado.` }));
                broadcast({ type: 'UPDATE_STATE', db });
            }

        } catch (e) {
            console.error('Error procesando mensaje:', e);
        }
    });
});

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Aria Gold Casino activo en el puerto ${PORT}`);
});
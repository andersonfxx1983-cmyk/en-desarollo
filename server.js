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

const ADMIN_PASS = "admin123"; // Contraseña del administrador validada en el servidor
const INITIAL_BALANCE = 150000; // Bono de bienvenida

wss.on('connection', (ws) => {
    // Enviar el estado actual al cliente que se conecta
    ws.send(JSON.stringify({ type: 'UPDATE_STATE', db }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // 1. SISTEMA DE REGISTRO SEGURO (El servidor crea el UID)
            if (data.type === 'USER_REGISTER') {
                const { username, password } = data;
                if (db.users[username]) {
                    ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: false, message: '❌ El usuario ya existe.' }));
                    return;
                }
                
                // Generar UID único de 6 dígitos
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
            
            // 2. SISTEMA DE INICIO DE SESIÓN Y VERIFICACIÓN DE BANEO
            else if (data.type === 'USER_LOGIN') {
                const { username, password } = data;
                const user = db.users[username];
                
                if (!user || user.password !== password) {
                    ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: false, message: '❌ Usuario o contraseña incorrectos.' }));
                    return;
                }
                
                // Verificar si el baneo ya expiró
                if (user.banned && user.banExpires !== -1 && Date.now() > user.banExpires) {
                    user.banned = false;
                    user.banReason = '';
                    user.banExpires = 0;
                }

                if (user.banned) {
                    ws.send(JSON.stringify({ type: 'BANNED_RESPONSE', user }));
                    return;
                }
                
                ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: true, username, balance: user.balance, uid: user.uid }));
            }
            
            // 3. TRANSFERENCIAS ENTRE USUARIOS
            else if (data.type === 'MAKE_TRANSFER') {
                const { senderUsername, recipientUid, amount } = data;
                const sender = db.users[senderUsername];
                let recipientUsername = Object.keys(db.users).find(u => db.users[u].uid === recipientUid);

                if (!sender || !recipientUsername || senderUsername === recipientUsername || isNaN(amount) || amount <= 0 || sender.balance < amount) {
                    ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: false, message: '❌ Transferencia inválida o saldo insuficiente.' }));
                    return;
                }

                sender.balance -= amount;
                db.users[recipientUsername].balance += amount;

                ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: true, newBalance: sender.balance, message: `✅ ¡Enviaste $${amount.toLocaleString()} COP!` }));
                broadcast({ type: 'UPDATE_STATE', db });
            }

            // 4. SISTEMA DE ADMINISTRADOR (RECARGAS Y BANEO)
            else if (data.type === 'ADMIN_MODIFY_BALANCE') {
                if (data.adminPass !== ADMIN_PASS) return ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: false, message: '❌ Contraseña admin incorrecta.' }));
                
                const { target, action, amount } = data;
                let targetKey = Object.keys(db.users).find(u => u === target || db.users[u].uid === target);
                
                if (!targetKey) return ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: false, message: '❌ Usuario no encontrado.' }));
                
                if (action === 'add') db.users[targetKey].balance += amount;
                else db.users[targetKey].balance = Math.max(0, db.users[targetKey].balance - amount);
                
                ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: true, message: `✅ Saldo de ${targetKey} actualizado.` }));
                broadcast({ type: 'UPDATE_STATE', db });
            }

            else if (data.type === 'ADMIN_BAN_USER') {
                if (data.adminPass !== ADMIN_PASS) return;
                const { target, reason, expireTime } = data;
                let targetKey = Object.keys(db.users).find(u => u === target || db.users[u].uid === target);
                
                if (!targetKey) return ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: false, message: '❌ Usuario no encontrado.' }));
                
                db.users[targetKey].banned = true;
                db.users[targetKey].banReason = reason;
                db.users[targetKey].banExpires = expireTime;
                
                ws.send(JSON.stringify({ type: 'ADMIN_RESPONSE', success: true, message: `⛔ Usuario ${targetKey} baneado.` }));
                broadcast({ type: 'UPDATE_STATE', db }); // Esto forzará la pantalla de ban a los conectados
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
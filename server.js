// server.js - Backend completo para Aria Gold Casino
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname))); // Sirve el index.html y archivos estáticos

// Base de datos simulada en memoria
// Estructura de usuarios: { username: { password, uid, balance, banned, banReason, banExpires } }
let db = {
    users: {},
    globalMultiplier: 1
};

// Manejo de WebSockets para sincronización en tiempo real desde cualquier dispositivo
wss.on('connection', (ws) => {
    // Enviar el estado actual al cliente que recién se conecta
    ws.send(JSON.stringify({ type: 'UPDATE_STATE', db }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'SYNC_STATE') {
                broadcast({ type: 'UPDATE_STATE', db });
            }
            else if (data.type === 'USER_REGISTER') {
                const { username, password, uid, initialBalance } = data;
                if (db.users[username]) {
                    ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: false, message: 'El usuario ya existe.' }));
                    return;
                }
                db.users[username] = {
                    password,
                    uid,
                    balance: initialBalance,
                    banned: false,
                    banReason: '',
                    banExpires: 0
                };
                ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: true, username, balance: initialBalance }));
                broadcast({ type: 'UPDATE_STATE', db });
            }
            else if (data.type === 'USER_LOGIN') {
                const { username, password } = data;
                const user = db.users[username];
                if (!user || user.password !== password) {
                    ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: false, message: 'Usuario o contraseña incorrectos.' }));
                    return;
                }
                if (user.banned) {
                    ws.send(JSON.stringify({ type: 'BANNED_RESPONSE', user }));
                    return;
                }
                ws.send(JSON.stringify({ type: 'AUTH_RESPONSE', success: true, username, balance: user.balance, uid: user.uid }));
            }
            else if (data.type === 'MAKE_TRANSFER') {
                // SISTEMA DE TRANSFERENCIAS REALES VALIDADO EN EL SERVIDOR
                const { senderUsername, recipientUid, amount } = data;

                const sender = db.users[senderUsername];
                let recipientUsername = null;

                // Buscar al destinatario por su UID único
                for (let uname in db.users) {
                    if (db.users[uname].uid === recipientUid) {
                        recipientUsername = uname;
                        break;
                    }
                }

                // Validaciones de seguridad en el servidor
                if (!sender) {
                    ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: false, message: 'Sesión de remitente no válida.' }));
                    return;
                }
                if (!recipientUsername) {
                    ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: false, message: '❌ No se encontró ningún usuario con ese UID.' }));
                    return;
                }
                if (senderUsername === recipientUsername) {
                    ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: false, message: '❌ No puedes enviarte dinero a ti mismo.' }));
                    return;
                }
                if (isNaN(amount) || amount <= 0) {
                    ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: false, message: '❌ Ingresa un monto válido.' }));
                    return;
                }
                if (sender.balance < amount) {
                    ws.send(JSON.stringify({ type: 'TRANSFER_RESPONSE', success: false, message: '❌ Fondos insuficientes en tu billetera.' }));
                    return;
                }

                // Ejecución atómica de la transferencia real
                sender.balance -= amount;
                db.users[recipientUsername].balance += amount;

                // Responder al emisor con su nuevo saldo actualizado
                ws.send(JSON.stringify({ 
                    type: 'TRANSFER_RESPONSE', 
                    success: true, 
                    newBalance: sender.balance, 
                    message: `✅ ¡Transferencia exitosa de $${amount.toLocaleString()} COP to ${recipientUsername}!` 
                }));

                // Broadcast a todos los clientes para actualizar saldos y tablas en tiempo real
                broadcast({ type: 'UPDATE_STATE', db });
            }
            else if (data.type === 'ADMIN_ACTION') {
                // Acciones de administración sincronizadas
                db = data.updatedDb;
                broadcast({ type: 'UPDATE_STATE', db });
            }

        } catch (e) {
            console.error('Error procesando mensaje de WebSocket:', e);
        }
    });
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Aria Gold Casino activo en el puerto ${PORT}`);
});
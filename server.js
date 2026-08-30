// server.js - Servidor Web Backend para Aria Gold Casino (Hospedable en GitHub / Render / Heroku / Glitch)
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname))); // Sirve tu index.html y archivos estáticos

// Base de datos en memoria (para persistencia real puedes conectar MongoDB o SQLite)
let db = {
    users: {}, // { username: { password, uid, balance, banned, banReason, banExpires, admin } }
    globalMultiplier: 1
};

// WebSocket para sincronización en tiempo real desde cualquier otro dispositivo
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'SYNC_STATE') {
                // Enviar estado actualizado a todos los clientes conectados
                broadcast({ type: 'UPDATE_STATE', db });
            }
            else if (data.type === 'ADMIN_ACTION' || data.type === 'USER_ACTION') {
                // Actualizar base de datos según la acción recibida
                db = data.updatedDb;
                broadcast({ type: 'UPDATE_STATE', db });
            }
        } catch (e) {
            console.error('Error procesando mensaje WS:', e);
        }
    });

    // Enviar estado inicial al conectar
    ws.send(JSON.stringify({ type: 'UPDATE_STATE', db }));
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
    console.log(`Servidor de Aria Gold Casino corriendo en el puerto ${PORT}`);
});
// server.js - Backend centralizado y persistente para Aria Gold Casino
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.txt');

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const ADMIN_PASS = 'admin123';
const INITIAL_BALANCE = 0;
const WELCOME_BONUS_AMOUNT = 1000;

function createWelcomeCode(username) {
    const namePart = String(username || 'ARIA').substring(0, 4).toUpperCase().padEnd(4, 'A');
    return `ARIA-${namePart}-${Math.floor(1000 + Math.random() * 9000)}`;
}

function emptyDb() {
    return {
        users: {},
        globalMultiplier: 1,
        updatedAt: Date.now()
    };
}

function ensureDataFiles() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(USERS_FILE) || fs.readFileSync(USERS_FILE, 'utf8').trim() === '') {
        fs.writeFileSync(USERS_FILE, JSON.stringify(emptyDb(), null, 2), 'utf8');
    }
}

function loadDb() {
    ensureDataFiles();
    try {
        const raw = fs.readFileSync(USERS_FILE, 'utf8');
        if (!raw.trim()) return emptyDb();
        const parsed = JSON.parse(raw);
        return {
            users: parsed.users || {},
            globalMultiplier: parsed.globalMultiplier || 1,
            updatedAt: parsed.updatedAt || Date.now()
        };
    } catch (error) {
        console.warn('No se pudo leer users.txt, se regeneró la base de datos.');
        const freshDb = emptyDb();
        fs.writeFileSync(USERS_FILE, JSON.stringify(freshDb, null, 2), 'utf8');
        return freshDb;
    }
}

function saveDb() {
    ensureDataFiles();
    db.updatedAt = Date.now();
    fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function normalizeUser(user, username) {
    return {
        username,
        password: user.password,
        uid: user.uid,
        balance: Number(user.balance) || 0,
        welcomeCode: user.welcomeCode || '',
        welcomeCodeRedeemed: Boolean(user.welcomeCodeRedeemed),
        banned: Boolean(user.banned),
        banReason: user.banReason || '',
        banExpires: Number(user.banExpires) || 0,
        bannedBy: user.bannedBy || 'Administrador General',
        createdAt: user.createdAt || Date.now()
    };
}

function findUserByTarget(target) {
    if (!target) return null;
    const userEntry = Object.entries(db.users).find(([username, user]) => username === target || user.uid === target);
    return userEntry ? userEntry[0] : null;
}

function applyUserBan(username, reason, expireTime, adminName = 'Administrador Master') {
    const user = db.users[username];
    if (!user) return false;

    user.banned = true;
    user.banReason = reason || 'Violación de políticas del casino.';
    user.bannedBy = adminName;
    user.banExpires = expireTime;
    saveDb();
    return true;
}

function resolveBans() {
    Object.keys(db.users).forEach((username) => {
        const user = db.users[username];
        if (user.banned && user.banExpires !== -1 && Number(user.banExpires) !== 0 && Date.now() > Number(user.banExpires)) {
            user.banned = false;
            user.banReason = '';
            user.banExpires = 0;
            user.bannedBy = '';
        }
    });
    saveDb();
}

let db = loadDb();

function broadcast(data) {
    const payload = JSON.stringify(data);
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    });
}

app.get('/api/health', (req, res) => {
    res.json({ success: true, message: 'Aria Gold Casino activo', users: Object.keys(db.users).length });
});

app.get('/api/users', (req, res) => {
    resolveBans();
    res.json({ success: true, users: Object.fromEntries(Object.entries(db.users).map(([username, user]) => [username, normalizeUser(user, username)])) });
});

app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password || String(username).trim() === '') {
        return res.status(400).json({ success: false, message: '❌ Datos inválidos.' });
    }
    const safeUsername = String(username).trim();
    if (db.users[safeUsername]) {
        return res.status(409).json({ success: false, message: '❌ El usuario ya existe.' });
    }

    let newUid = '';
    do {
        newUid = Math.floor(100000 + Math.random() * 900000).toString();
    } while (Object.values(db.users).some((user) => user.uid === newUid));

    const welcomeCode = createWelcomeCode(safeUsername);
    const user = {
        username: safeUsername,
        password: String(password),
        uid: newUid,
        balance: INITIAL_BALANCE,
        welcomeCode,
        welcomeCodeRedeemed: false,
        banned: false,
        banReason: '',
        banExpires: 0,
        bannedBy: '',
        createdAt: Date.now()
    };

    db.users[safeUsername] = user;
    saveDb();
    broadcast({ type: 'UPDATE_STATE', db });
    res.json({ success: true, username: safeUsername, uid: newUid, balance: INITIAL_BALANCE, welcomeCode, welcomeCodeRedeemed: false, user: normalizeUser(user, safeUsername), message: '✅ Cuenta creada correctamente. Código de bienvenida: ' + welcomeCode });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, message: '❌ Debes enviar usuario y contraseña.' });
    }

    resolveBans();
    const targetUser = db.users[String(username).trim()];
    if (!targetUser || targetUser.password !== String(password)) {
        return res.status(401).json({ success: false, message: '❌ Usuario o contraseña incorrectos.' });
    }

    if (targetUser.banned) {
        return res.status(403).json({ success: false, message: '⛔ Cuenta suspendida por el administrador.', banned: true, user: normalizeUser(targetUser, username), username: String(username).trim() });
    }

    res.json({
        success: true,
        username: String(username).trim(),
        uid: targetUser.uid,
        balance: targetUser.balance,
        welcomeCode: targetUser.welcomeCode || null,
        welcomeCodeRedeemed: Boolean(targetUser.welcomeCodeRedeemed),
        user: normalizeUser(targetUser, String(username).trim())
    });
});

app.post('/api/redeem-code', (req, res) => {
    const { username, password, code } = req.body || {};
    if (!username || !password || !code) {
        return res.status(400).json({ success: false, message: '❌ Debes enviar usuario, contraseña y código.' });
    }

    const targetUser = db.users[String(username).trim()];
    if (!targetUser || targetUser.password !== String(password)) {
        return res.status(401).json({ success: false, message: '❌ Usuario o contraseña incorrectos.' });
    }

    if (targetUser.welcomeCode !== String(code).trim()) {
        return res.status(400).json({ success: false, message: '❌ El código no pertenece a esta cuenta.' });
    }

    if (targetUser.welcomeCodeRedeemed) {
        return res.status(409).json({ success: false, message: '⚠️ Este código ya fue canjeado.' });
    }

    targetUser.balance += WELCOME_BONUS_AMOUNT;
    targetUser.welcomeCodeRedeemed = true;
    saveDb();
    broadcast({ type: 'UPDATE_STATE', db });

    res.json({
        success: true,
        newBalance: targetUser.balance,
        bonus: WELCOME_BONUS_AMOUNT,
        message: `✅ Código canjeado correctamente. +${WELCOME_BONUS_AMOUNT} COP.`
    });
});

app.post('/api/transfer', (req, res) => {
    const { senderUsername, recipientUid, amount } = req.body || {};
    const sender = db.users[String(senderUsername || '').trim()];
    const recipientKey = findUserByTarget(String(recipientUid || ''));
    const amt = Number(amount);

    if (!sender || !recipientKey || senderUsername === recipientKey || !Number.isFinite(amt) || amt <= 0 || sender.balance < amt) {
        return res.status(400).json({ success: false, message: '❌ Transferencia inválida o saldo insuficiente.' });
    }

    sender.balance -= amt;
    db.users[recipientKey].balance += amt;
    saveDb();
    broadcast({ type: 'UPDATE_STATE', db });
    res.json({ success: true, newBalance: sender.balance, message: `✅ Transferencia enviada a ${recipientKey}.`, recipient: recipientKey, amount: amt });
});

app.post('/api/recharge', (req, res) => {
    const { username, amount } = req.body || {};
    const user = db.users[String(username || '').trim()];
    const amt = Number(amount);

    if (!user || !Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ success: false, message: '❌ Recarga inválida.' });
    }

    user.balance += amt;
    saveDb();
    broadcast({ type: 'UPDATE_STATE', db });
    res.json({ success: true, newBalance: user.balance, message: `✅ Recarga de $${amt.toLocaleString('es-CO')} COP aplicada.` });
});

app.post('/api/withdraw', (req, res) => {
    const { username, amount, account } = req.body || {};
    const user = db.users[String(username || '').trim()];
    const amt = Number(amount);

    if (!user || !Number.isFinite(amt) || amt <= 0 || !account || !String(account).trim()) {
        return res.status(400).json({ success: false, message: '❌ Datos de retiro inválidos.' });
    }
    if (user.balance < amt) {
        return res.status(400).json({ success: false, message: '❌ Fondos insuficientes para retirar.' });
    }

    user.balance -= amt;
    saveDb();
    broadcast({ type: 'UPDATE_STATE', db });
    res.json({ success: true, newBalance: user.balance, message: `✅ Retiro de $${amt.toLocaleString('es-CO')} COP procesado.` });
});

app.post('/api/admin', (req, res) => {
    const { adminPass, action, target, amount, reason, timeValue, timeUnit, adminName = 'Administrador Master' } = req.body || {};

    if (adminPass !== ADMIN_PASS) {
        return res.status(401).json({ success: false, message: '❌ Contraseña de administrador incorrecta.' });
    }

    if (action === 'balance') {
        const targetUser = findUserByTarget(String(target || ''));
        const user = targetUser ? db.users[targetUser] : null;
        const amt = Number(amount);
        if (!user || !Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ success: false, message: '❌ Usuario o monto inválidos.' });
        }

        if (String(req.body.mode || 'add') === 'subtract') {
            user.balance = Math.max(0, user.balance - amt);
            saveDb();
            broadcast({ type: 'UPDATE_STATE', db });
            return res.json({ success: true, message: `✅ Se retiraron $${amt.toLocaleString('es-CO')} COP de ${targetUser}.` });
        }

        user.balance += amt;
        saveDb();
        broadcast({ type: 'UPDATE_STATE', db });
        return res.json({ success: true, message: `✅ Se acreditaron $${amt.toLocaleString('es-CO')} COP a ${targetUser}.` });
    }

    if (action === 'send') {
        const targetUser = findUserByTarget(String(target || ''));
        const user = targetUser ? db.users[targetUser] : null;
        const amt = Number(amount);
        if (!user || !Number.isFinite(amt) || amt <= 0) {
            return res.status(400).json({ success: false, message: '❌ Usuario o monto inválidos.' });
        }
        user.balance += amt;
        saveDb();
        broadcast({ type: 'UPDATE_STATE', db });
        return res.json({ success: true, message: `✅ Se enviaron $${amt.toLocaleString('es-CO')} COP a ${targetUser}.` });
    }

    if (action === 'ban') {
        const targetUser = findUserByTarget(String(target || ''));
        if (!targetUser) {
            return res.status(404).json({ success: false, message: '❌ Usuario no encontrado.' });
        }

        let expireAt = 0;
        if (String(timeUnit || '').toLowerCase() === 'permanent') {
            expireAt = -1;
        } else {
            const mult = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000, months: 2592000000 };
            const val = Number(timeValue) || 0;
            expireAt = Date.now() + (val * (mult[String(timeUnit).toLowerCase()] || 1000));
        }

        applyUserBan(targetUser, reason || 'Violación de normas del casino.', expireAt, adminName);
        broadcast({ type: 'UPDATE_STATE', db });
        return res.json({ success: true, message: `🚫 Usuario ${targetUser} suspendido.` });
    }

    if (action === 'unban') {
        const targetUser = findUserByTarget(String(target || ''));
        if (!targetUser) {
            return res.status(404).json({ success: false, message: '❌ Usuario no encontrado.' });
        }
        const user = db.users[targetUser];
        user.banned = false;
        user.banReason = '';
        user.banExpires = 0;
        user.bannedBy = '';
        saveDb();
        broadcast({ type: 'UPDATE_STATE', db });
        return res.json({ success: true, message: `✅ Usuario ${targetUser} desbaneado.` });
    }

    if (action === 'reset') {
        Object.keys(db.users).forEach((username) => {
            db.users[username].balance = INITIAL_BALANCE;
        });
        saveDb();
        broadcast({ type: 'UPDATE_STATE', db });
        return res.json({ success: true, message: '✅ Saldos reiniciados sin borrar cuentas.' });
    }

    return res.status(400).json({ success: false, message: '❌ Acción administrativa no reconocida.' });
});

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'UPDATE_STATE', db }));
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg.toString());
            if (data.type === 'PING') {
                ws.send(JSON.stringify({ type: 'PONG', success: true, db }));
            }
        } catch (error) {
            console.error('Error en WebSocket:', error);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor de Aria Gold Casino activo en el puerto ${PORT}`);
    console.log(`Archivo persistente: ${USERS_FILE}`);
});
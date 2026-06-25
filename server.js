const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Serve frontend assets from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// --- AUTHENTICATION & CREDENTIALS DATABASE ---
const CREDENTIALS = {
    admins: {
        "admin1": "dplAdminPass1!",
        "admin2": "dplAdminPass2!"
    },
    owners: {
        "owner1": { password: "kolkatapassword", name: "Abhishek", teamName: "Kolkata Knights" },
        "owner2": { password: "mumbaipassword", name: "Rahul", teamName: "Mumbai Mavericks" },
        "owner3": { password: "delhipassword", name: "Vikram", teamName: "Delhi Dynamos" },
        "owner4": { password: "chennaipassword", name: "Suresh", teamName: "Chennai Chargers" },
        "owner5": { password: "bengalurupassword", name: "Amit", teamName: "Bengaluru Blasters" }
    }
};

// --- CORE APP STATE ---
let globalConfig = {
    startingPurse: 100000000 // Default 100M, overridable by Admin
};

let owners = {}; // Active owners runtime map populated dynamically upon admin initialization

let playerPool = [
    { name: "Erling Haaland", position: "FW", rating: 91, club: "Man City", basePrice: 15000000, status: "Available" },
    { name: "Kevin De Bruyne", position: "MF", rating: 90, club: "Man City", basePrice: 12000000, status: "Available" },
    { name: "Virgil van Dijk", position: "DF", rating: 89, club: "Liverpool", basePrice: 10000000, status: "Available" }
];

let currentAuction = {
    player: playerPool[0],
    currentBid: playerPool[0].basePrice,
    highestBidderId: null,
    highestBidderTeam: "No Bids Yet",
    timer: 15,
    isPaused: true,
    history: []
};

let countdownInterval = null;

// Populate initial structures based on defaults
function initLeagueState(startingPurseValue) {
    globalConfig.startingPurse = parseInt(startingPurseValue);
    for (let id in CREDENTIALS.owners) {
        owners[id] = {
            name: CREDENTIALS.owners[id].name,
            teamName: CREDENTIALS.owners[id].teamName,
            purse: globalConfig.startingPurse,
            squad: []
        };
    }
}
initLeagueState(globalConfig.startingPurse);

function broadcastState() {
    io.emit('auction_state_update', { currentAuction, owners, playerPool, globalConfig });
}

function startTimer() {
    clearInterval(countdownInterval);
    currentAuction.isPaused = false;
    
    countdownInterval = setInterval(() => {
        if (!currentAuction.isPaused) {
            currentAuction.timer--;
            io.emit('timer_tick', currentAuction.timer);

            if (currentAuction.timer <= 0) {
                clearInterval(countdownInterval);
                executeHammer();
            }
        }
    }, 1000);
}

function executeHammer() {
    const winnerId = currentAuction.highestBidderId;
    const finalPrice = currentAuction.currentBid;
    const soldPlayer = currentAuction.player;

    if (winnerId && owners[winnerId]) {
        owners[winnerId].purse -= finalPrice;
        owners[winnerId].squad.push({ ...soldPlayer, finalPrice });
        
        let idx = playerPool.findIndex(p => p.name === soldPlayer.name);
        if (idx !== -1) playerPool[idx].status = `Sold to ${owners[winnerId].teamName}`;

        io.emit('notification', { 
            type: 'success', 
            message: `🎉 SOLD! ${soldPlayer.name} to ${owners[winnerId].teamName} for € ${(finalPrice/1000000).toFixed(1)}M!` 
        });
    } else {
        let idx = playerPool.findIndex(p => p.name === soldPlayer.name);
        if (idx !== -1) playerPool[idx].status = "Unsold";
        io.emit('notification', { type: 'info', message: `❌ ${soldPlayer.name} went Unsold!` });
    }

    const nextPlayer = playerPool.find(p => p.status === "Available");
    if (nextPlayer) {
        setupNextPlayer(nextPlayer);
    } else {
        currentAuction.player = { name: "Auction Concluded", position: "N/A", rating: 0, club: "None", basePrice: 0 };
        currentAuction.isPaused = true;
    }
    broadcastState();
}

function setupNextPlayer(player) {
    currentAuction.player = player;
    currentAuction.currentBid = player.basePrice;
    currentAuction.highestBidderId = null;
    currentAuction.highestBidderTeam = "No Bids Yet";
    currentAuction.timer = 15;
    currentAuction.isPaused = true;
    currentAuction.history = [];
}

// --- WEBSOCKET EVENT COORDINATION ---
io.on('connection', (socket) => {
    
    // Auth Validation System
    socket.on('attempt_login', (data) => {
        const { username, password } = data;
        
        // Check Admin credentials
        if (CREDENTIALS.admins[username] && CREDENTIALS.admins[username] === password) {
            return socket.emit('login_response', { success: true, role: 'admin', userId: username });
        }
        // Check Owner credentials
        if (CREDENTIALS.owners[username] && CREDENTIALS.owners[username].password === password) {
            return socket.emit('login_response', { success: true, role: 'owner', userId: username, meta: owners[username] });
        }
        
        socket.emit('login_response', { success: false, message: "Invalid Account Credentials" });
    });

    socket.on('request_sync', () => {
        socket.emit('init_sync', { currentAuction, owners, playerPool, globalConfig });
    });

    socket.on('place_bid', (data) => {
        const { ownerId, amount } = data;
        if (currentAuction.isPaused) return socket.emit('notification', { type: 'error', message: 'Auction is currently paused!' });
        if (!owners[ownerId]) return socket.emit('notification', { type: 'error', message: 'Unauthorized profile bidding privileges.' });

        if (amount > currentAuction.currentBid && amount <= owners[ownerId].purse) {
            currentAuction.currentBid = amount;
            currentAuction.highestBidderId = ownerId;
            currentAuction.highestBidderTeam = owners[ownerId].teamName;
            currentAuction.timer = 15; 
            
            currentAuction.history.unshift({
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                team: owners[ownerId].teamName,
                amount: amount
            });

            io.emit('bid_confirmed', currentAuction);
            io.emit('timer_tick', currentAuction.timer);
            broadcastState();
        } else {
            socket.emit('notification', { type: 'error', message: 'Bid denied. Check balance rules or raise requirements.' });
        }
    });

    // Admin Control Engine Rules
    socket.on('admin_control', (data) => {
        const { action, value } = data;
        
        if (action === 'set_purse') {
            initLeagueState(value);
            io.emit('notification', { type: 'info', message: `💼 Admin set starting league purse to € ${(value/1000000).toFixed(1)}M!` });
        }
        if (action === 'start') startTimer();
        if (action === 'pause') currentAuction.isPaused = true;
        if (action === 'skip') {
            const nextPlayer = playerPool.find(p => p.status === "Available" && p.name !== currentAuction.player.name);
            if (nextPlayer) setupNextPlayer(nextPlayer);
        }
        if (action === 'undo') {
            if (currentAuction.history.length > 1) {
                currentAuction.history.shift();
                const lastBid = currentAuction.history[0];
                currentAuction.currentBid = lastBid.amount;
                const foundId = Object.keys(owners).find(k => owners[k].teamName === lastBid.team);
                currentAuction.highestBidderId = foundId || null;
                currentAuction.highestBidderTeam = lastBid.team;
            } else {
                setupNextPlayer(currentAuction.player);
            }
        }
        broadcastState();
    });

    socket.on('admin_add_player', (playerData) => {
        const newPlayer = {
            name: playerData.name,
            position: playerData.position,
            rating: parseInt(playerData.rating) || 80,
            club: playerData.club || "Free Agent",
            basePrice: parseInt(playerData.basePrice) || 5000000,
            status: "Available"
        };
        playerPool.push(newPlayer);
        if (currentAuction.player.name === "Auction Concluded") {
            setupNextPlayer(newPlayer);
        }
        broadcastState();
        io.emit('notification', { type: 'success', message: `🏃 Global Pool Add: ${newPlayer.name}` });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Network Cluster Live on Port: ${PORT}`));

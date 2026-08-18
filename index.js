require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

// ====== CONFIGURACIÓN (viene de las variables de entorno, ver .env.example) ======
const {
  TELEGRAM_BOT_TOKEN,
  TRACKED_WALLET,
  SIM_SOL_PER_TRADE,
  HELIUS_WEBHOOK_SECRET,
  HELIUS_API_KEY,
  HELIUS_WEBHOOK_ID,
  PORT,
  DAILY_SUMMARY_HOUR, // hora del día (0-23) para el resumen diario
} = process.env;

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!TELEGRAM_BOT_TOKEN || ALLOWED_USER_IDS.length === 0) {
  console.error('Faltan variables de entorno obligatorias: TELEGRAM_BOT_TOKEN, ALLOWED_USER_IDS');
  process.exit(1);
}

const DEFAULT_SIM_AMOUNT = parseFloat(SIM_SOL_PER_TRADE || '1');
// STATE_DIR apunta a la carpeta del volumen persistente en Railway (ver DEPLOY.md).
// Si no configurás un volumen, usa la carpeta del proyecto (y se pierde en cada redeploy).
const STATE_DIR = process.env.STATE_DIR || __dirname;
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// ====== ESTADO PERSISTENTE (se guarda en un archivo JSON) ======
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (typeof loaded.simAmount !== 'number') loaded.simAmount = DEFAULT_SIM_AMOUNT;
    if (!Array.isArray(loaded.trackedWallets)) loaded.trackedWallets = [];
    if (!loaded.positions) loaded.positions = {};
    return loaded;
  }
  return {
    trackedWallets: TRACKED_WALLET ? [TRACKED_WALLET] : [],
    positions: {}, // positions[wallet][mint] = {...}
    dailyTrades: [],
    totalSimPnl: 0,
    simAmount: DEFAULT_SIM_AMOUNT,
  };
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
let state = loadState();
if (!state.positions) state.positions = {};
state.trackedWallets.forEach((w) => {
  if (!state.positions[w]) state.positions[w] = {};
});
saveState(state);

// ====== BOT DE TELEGRAM ======
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function isAllowed(userId) {
  return ALLOWED_USER_IDS.includes(String(userId));
}

function broadcast(message) {
  ALLOWED_USER_IDS.forEach((chatId) => {
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }).catch((err) =>
      console.error('Error enviando mensaje a', chatId, err.message)
    );
  });
}

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : 'desconocido';
}

// ====== INTEGRACIÓN CON LA API DE HELIUS (para agregar/sacar wallets del webhook) ======
async function updateHeliusWebhookAddresses(newAddressList) {
  if (!HELIUS_API_KEY || !HELIUS_WEBHOOK_ID) {
    throw new Error(
      'Faltan HELIUS_API_KEY o HELIUS_WEBHOOK_ID en las variables de entorno. Agregalas en Railway para poder usar /addwallet y /removewallet.'
    );
  }
  const url = `https://api.helius.xyz/v0/webhooks/${HELIUS_WEBHOOK_ID}?api-key=${HELIUS_API_KEY}`;

  // 1. Traemos la configuración actual del webhook
  const getRes = await fetch(url);
  if (!getRes.ok) throw new Error(`No pude leer el webhook actual de Helius (status ${getRes.status})`);
  const current = await getRes.json();

  // 2. Armamos el body SOLO con los campos que Helius espera en el PUT
  //    (reenviar la respuesta completa del GET puede incluir campos de solo lectura y causar un 400)
  const updated = {
    webhookURL: current.webhookURL,
    transactionTypes: current.transactionTypes,
    accountAddresses: newAddressList,
    webhookType: current.webhookType,
  };
  if (current.authHeader) updated.authHeader = current.authHeader;
  if (current.txnStatus) updated.txnStatus = current.txnStatus;

  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  if (!putRes.ok) {
    const errBody = await putRes.text().catch(() => '');
    throw new Error(`Helius rechazó la actualización (status ${putRes.status}) ${errBody.slice(0, 200)}`);
  }
}

// ====== COMANDOS DE TELEGRAM ======
bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const walletsList = state.trackedWallets.map((w) => `• \`${shortAddr(w)}\``).join('\n') || 'ninguna todavía';
  bot.sendMessage(
    msg.chat.id,
    `🤖 *Bot de simulación activo*\n\nWallets trackeadas:\n${walletsList}\n\nMonto simulado por trade: *${state.simAmount} SOL*\n\nComandos:\n/status — posiciones abiertas y ganancia total\n/pnl — ganancia/pérdida acumulada\n/setsol <monto> — cambiar SOL simulado por trade\n/wallets — ver wallets trackeadas\n/addwallet <dirección> — sumar una wallet\n/removewallet <dirección> — sacar una wallet`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/setsol(?:\s+([\d.]+))?/, (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const value = parseFloat(match[1]);
  if (!value || value <= 0) {
    bot.sendMessage(msg.chat.id, 'Usalo así: `/setsol 2` (para simular 2 SOL por trade)', { parse_mode: 'Markdown' });
    return;
  }
  state.simAmount = value;
  saveState(state);
  bot.sendMessage(msg.chat.id, `✅ Listo. De ahora en más voy a simular *${value} SOL* por cada trade nuevo.`, {
    parse_mode: 'Markdown',
  });
});

bot.onText(/\/wallets/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const list = state.trackedWallets.map((w) => `• \`${w}\``).join('\n') || 'No hay wallets trackeadas todavía.';
  bot.sendMessage(msg.chat.id, `👀 *Wallets trackeadas:*\n${list}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/addwallet(?:\s+(\S+))?/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const address = match[1];
  if (!address || address.length < 32) {
    bot.sendMessage(msg.chat.id, 'Usalo así: `/addwallet DIRECCION_DE_SOLANA`', { parse_mode: 'Markdown' });
    return;
  }
  if (state.trackedWallets.includes(address)) {
    bot.sendMessage(msg.chat.id, 'Esa wallet ya la estoy trackeando.');
    return;
  }

  const newList = [...state.trackedWallets, address];
  try {
    bot.sendMessage(msg.chat.id, '⏳ Agregando wallet en Helius, un segundo...');
    await updateHeliusWebhookAddresses(newList);
    state.trackedWallets = newList;
    state.positions[address] = {};
    saveState(state);
    bot.sendMessage(msg.chat.id, `✅ Wallet \`${shortAddr(address)}\` agregada. Ya la estoy trackeando.`, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ No pude agregarla: ${err.message}`);
  }
});

bot.onText(/\/removewallet(?:\s+(\S+))?/, async (msg, match) => {
  if (!isAllowed(msg.from.id)) return;
  const address = match[1];
  if (!address || !state.trackedWallets.includes(address)) {
    bot.sendMessage(msg.chat.id, 'Esa wallet no está en la lista. Usá /wallets para ver cuáles están trackeadas.');
    return;
  }

  const newList = state.trackedWallets.filter((w) => w !== address);
  try {
    bot.sendMessage(msg.chat.id, '⏳ Sacando wallet de Helius, un segundo...');
    await updateHeliusWebhookAddresses(newList);
    state.trackedWallets = newList;
    delete state.positions[address];
    saveState(state);
    bot.sendMessage(msg.chat.id, `✅ Wallet \`${shortAddr(address)}\` sacada. Ya no la trackeo más.`, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    bot.sendMessage(msg.chat.id, `❌ No pude sacarla: ${err.message}`);
  }
});

bot.onText(/\/debug/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const events = state.lastRawEvents || [];
  if (events.length === 0) {
    bot.sendMessage(msg.chat.id, 'Todavía no llegó ningún evento de Helius a este servidor.');
    return;
  }
  let text = `🔍 *Últimos ${events.length} eventos recibidos:*\n\n`;
  events.forEach((e, i) => {
    text += `*${i + 1}.* tipo: \`${e.type || 'sin tipo'}\`\nfeePayer: \`${shortAddr(e.feePayer)}\`\ntiene swap: ${e.hasSwap ? 'sí' : 'NO'}\ncoincide con wallet trackeada: ${e.matches ? 'sí' : 'NO'}\n\n`;
  });
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  let text = `📊 *Estado actual*\n\nPnL simulado acumulado: *${state.totalSimPnl.toFixed(4)} SOL*\n\n`;
  const wallets = Object.keys(state.positions);
  let anyOpen = false;
  wallets.forEach((wallet) => {
    const open = Object.entries(state.positions[wallet] || {});
    if (open.length === 0) return;
    anyOpen = true;
    text += `*Wallet ${shortAddr(wallet)}:*\n`;
    open.forEach(([mint, pos]) => {
      text += `• ${shortAddr(mint)} — invertido: ${pos.simSolIn.toFixed(4)} SOL\n`;
    });
    text += '\n';
  });
  if (!anyOpen) text += 'No hay posiciones abiertas ahora mismo.';
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/pnl/, (msg) => {
  if (!isAllowed(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, `💰 PnL simulado acumulado: *${state.totalSimPnl.toFixed(4)} SOL*`, {
    parse_mode: 'Markdown',
  });
});

// ====== SERVIDOR WEB (acá le pega Helius cada vez que alguna wallet trackeada hace un trade) ======
const app = express();
app.use(express.json());

app.post('/webhook', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (HELIUS_WEBHOOK_SECRET && authHeader !== HELIUS_WEBHOOK_SECRET) {
    return res.status(401).send('unauthorized');
  }
  const events = Array.isArray(req.body) ? req.body : [req.body];
  events.forEach(processTransaction);
  res.status(200).send('ok');
});

app.get('/', (_req, res) => res.send('Bot de simulación corriendo ✅'));

function findTrackedWallet(tx, swap) {
  const candidates = new Set();
  if (tx.feePayer) candidates.add(tx.feePayer);
  if (swap?.nativeInput?.account) candidates.add(swap.nativeInput.account);
  if (swap?.nativeOutput?.account) candidates.add(swap.nativeOutput.account);
  (swap?.tokenInputs || []).forEach((t) => t.userAccount && candidates.add(t.userAccount));
  (swap?.tokenOutputs || []).forEach((t) => t.userAccount && candidates.add(t.userAccount));
  (tx.tokenTransfers || []).forEach((t) => {
    if (t.fromUserAccount) candidates.add(t.fromUserAccount);
    if (t.toUserAccount) candidates.add(t.toUserAccount);
  });
  (tx.accountData || []).forEach((a) => a.account && candidates.add(a.account));

  return state.trackedWallets.find((w) => candidates.has(w));
}

function processTransaction(tx) {
  try {
    // protección contra duplicados: Helius puede reenviar el mismo evento más de una vez
    if (!state.processedSignatures) state.processedSignatures = [];
    if (tx.signature) {
      if (state.processedSignatures.includes(tx.signature)) return; // ya lo procesamos
      state.processedSignatures.unshift(tx.signature);
      state.processedSignatures = state.processedSignatures.slice(0, 300); // solo guardamos las últimas 300
    }

    const swap = tx?.events?.swap;
    const wallet = findTrackedWallet(tx, swap);
    const matches = !!wallet;

    // guardamos un registro liviano de este evento para poder inspeccionarlo con /debug
    if (!state.lastRawEvents) state.lastRawEvents = [];
    state.lastRawEvents.unshift({ type: tx.type, feePayer: tx.feePayer, hasSwap: !!swap, matches });
    state.lastRawEvents = state.lastRawEvents.slice(0, 5);
    saveState(state);

    if (!swap) return;
    if (!matches) return; // no encontramos ninguna wallet trackeada involucrada en esta tx

    const isBuy = !!swap.nativeInput && swap.tokenOutputs?.length > 0;
    const isSell = !!swap.nativeOutput && swap.tokenInputs?.length > 0;

    if (isBuy) {
      const realSol = Number(swap.nativeInput.amount) / 1e9;
      const token = swap.tokenOutputs[0];
      const realTokenAmount = Number(token.rawTokenAmount.tokenAmount) / 10 ** token.rawTokenAmount.decimals;
      handleBuy(wallet, token.mint, realSol, realTokenAmount);
    } else if (isSell) {
      const realSol = Number(swap.nativeOutput.amount) / 1e9;
      const token = swap.tokenInputs[0];
      const realTokenAmount = Number(token.rawTokenAmount.tokenAmount) / 10 ** token.rawTokenAmount.decimals;
      handleSell(wallet, token.mint, realSol, realTokenAmount);
    }
  } catch (err) {
    console.error('Error procesando transacción:', err.message);
  }
}

function handleBuy(wallet, mint, realSol, realTokenAmount) {
  const simSolIn = state.simAmount;
  const simTokenAmount = simSolIn * (realTokenAmount / realSol);

  if (!state.positions[wallet]) state.positions[wallet] = {};
  const existing = state.positions[wallet][mint];
  if (existing) {
    existing.simSolIn += simSolIn;
    existing.simTokenAmount += simTokenAmount;
    existing.realTokenAmountBought += realTokenAmount;
  } else {
    state.positions[wallet][mint] = {
      simSolIn,
      simTokenAmount,
      realTokenAmountBought: realTokenAmount,
      firstBuyTime: Date.now(),
    };
  }

  state.dailyTrades.push({ type: 'buy', wallet, mint, simSolIn, timestamp: Date.now() });
  saveState(state);

  broadcast(
    `🟢 *COMPRA simulada*\nWallet: \`${shortAddr(wallet)}\`\nToken: \`${shortAddr(mint)}\`\nMonto simulado: *${simSolIn.toFixed(4)} SOL*\n(el trader puso ${realSol.toFixed(4)} SOL)`
  );
}

function handleSell(wallet, mint, realSol, realTokenAmount) {
  const position = state.positions[wallet]?.[mint];
  if (!position) return; // vendió algo que no vimos comprar, no lo podemos simular

  const fraction = Math.min(1, realTokenAmount / position.realTokenAmountBought);
  const simTokenAmountSold = position.simTokenAmount * fraction;
  const simSolInPortion = position.simSolIn * fraction;
  const simSolOut = simTokenAmountSold * (realSol / realTokenAmount);
  const pnlSim = simSolOut - simSolInPortion;

  position.simTokenAmount -= simTokenAmountSold;
  position.simSolIn -= simSolInPortion;
  position.realTokenAmountBought -= realTokenAmount;

  if (position.realTokenAmountBought <= 0.000001) {
    delete state.positions[wallet][mint];
  }

  state.totalSimPnl += pnlSim;
  state.dailyTrades.push({ type: 'sell', wallet, mint, simSolOut, pnlSim, timestamp: Date.now() });
  saveState(state);

  const emoji = pnlSim >= 0 ? '✅' : '🔴';
  broadcast(
    `${emoji} *VENTA simulada*\nWallet: \`${shortAddr(wallet)}\`\nToken: \`${shortAddr(mint)}\`\nResultado: *${pnlSim >= 0 ? '+' : ''}${pnlSim.toFixed(4)} SOL*\nPnL total acumulado: *${state.totalSimPnl.toFixed(4)} SOL*`
  );
}

// ====== RESUMEN DIARIO ======
const summaryHour = parseInt(DAILY_SUMMARY_HOUR || '21', 10);
cron.schedule(`0 ${summaryHour} * * *`, () => {
  const trades = state.dailyTrades;
  const buys = trades.filter((t) => t.type === 'buy').length;
  const sells = trades.filter((t) => t.type === 'sell');
  const dayPnl = sells.reduce((acc, t) => acc + t.pnlSim, 0);

  let text = `📅 *Resumen del día*\n\nCompras simuladas: ${buys}\nVentas simuladas: ${sells.length}\nResultado del día: *${dayPnl >= 0 ? '+' : ''}${dayPnl.toFixed(4)} SOL*\n\nPnL total acumulado: *${state.totalSimPnl.toFixed(4)} SOL*`;

  if (trades.length === 0) {
    text = '📅 *Resumen del día*\n\nNinguna wallet trackeada operó hoy.';
  }

  broadcast(text);
  state.dailyTrades = [];
  saveState(state);
});

const port = PORT || 3000;
app.listen(port, () => {
  console.log(`Bot escuchando en el puerto ${port}`);
  console.log(`Trackeando wallets: ${state.trackedWallets.join(', ') || '(ninguna)'}`);
});
